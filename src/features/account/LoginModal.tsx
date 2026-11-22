import { useEffect, useId, useRef, useState } from "react";
import { api, isAndroid, isMobile, logLine } from "../../shared/api/api";
import type { User } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { Modal, Sheet } from "../../shared/ui/ui";
import { Button, Form, Input, SegmentedControl } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { IClose, IEye, IEyeOff, ILogin } from "../../shared/ui/icons";

/* 失败反馈（v3.0.6 #4）：真机上「账号密码错」和「线路挂了」都是一片安静 ——
 * 底层请求本身有 20s 超时，用户等不到 20s 就以为点了没反应。这里做三件事：
 *   1. 15s 先下结论，不让人干等；
 *   2. 超时 / 连不上 / 业务错误（服务端 msg，如「账号或密码错误」）分别给不同文案；
 *   3. 提交中在面板里显示「正在提交…」，超过 3s 补一句「线路较慢」，而不是只转个圈。
 */
const SUBMIT_TIMEOUT_MS = 15_000;
const TIMEOUT_FLAG = "__login_timeout__";
function withDeadline<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(TIMEOUT_FLAG)), ms);
    task.then(
      value => { window.clearTimeout(timer); resolve(value); },
      error => { window.clearTimeout(timer); reject(error); },
    );
  });
}
function loginErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? (error.message || "").trim() : "";
  if (raw === TIMEOUT_FLAG) return "线路没有响应（超过 15 秒）。请检查网络，或在「设置 · 网络」里换一条线路后重试。";
  if (!raw || raw === "请求失败，请检查网络") return "连不上站点：请检查网络，或在「设置 · 网络」里换一条线路后重试。";
  /* 其余原样显示服务端 msg（例如「账号或密码错误」），不要再包一层废话。 */
  return raw;
}

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast, accountScope, lineEpoch, beginGuestMerge } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /* 提交超过 3s 才提示「线路较慢」：既说明还在动，也给出可操作的建议 */
  const [slowSubmit, setSlowSubmit] = useState(false);
  const pending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  /* 浏览器/系统自动填充有时只写 DOM 不触发 onChange，state 会是空的。
     提交时以「state 优先、DOM 兜底」读值，避免"填了却提交空值"。 */
  const fieldValue = (name: string) => {
    const el = formRef.current?.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    return el?.value ?? "";
  };
  const mounted = useRef(true);
  const context = useRef({ accountScope, lineEpoch });
  context.current = { accountScope, lineEpoch };
  const requestEpoch = useRef(0);
  const errorId = useId();
  const passwordId = useId();
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => { requestEpoch.current++; };
    window.addEventListener("hg:line-changed", invalidate);
    window.addEventListener("hg:proxy-changed", invalidate);
    return () => {
      mounted.current = false;
      window.removeEventListener("hg:line-changed", invalidate);
      window.removeEventListener("hg:proxy-changed", invalidate);
    };
  }, []);
  useEffect(() => {
    if (loginOpen) {
      /* 打开即复位：万一上一轮提交卡在 pending/busy（网络半死不活、组件被复用），
         也不会出现"按钮点下去什么都不发生"这种死状态。 */
      pending.current = false;
      setBusy(false);
      setSlowSubmit(false);
      return;
    }
    setPassword(""); setShowPassword(false); setErr("");
  }, [loginOpen]);
  useEffect(() => {
    if (!busy) { setSlowSubmit(false); return undefined; }
    const timer = window.setTimeout(() => setSlowSubmit(true), 3000);
    return () => window.clearTimeout(timer);
  }, [busy]);
  const title = mode === "login" ? "登录 HGuoX" : "注册 HGuoX";
  const close = () => {
    if (pending.current) return;
    setLoginOpen(false);
  };
  const submit = async () => {
    // A ref locks synchronously: two submit events can arrive before React paints disabled.
    if (pending.current) {
      /* 连点第二次：给一句状态，别让用户以为点击丢了 */
      setSlowSubmit(true);
      return;
    }
    const account = (username.trim() || fieldValue("username").trim());
    const pass = (password || fieldValue("password"));
    const mail = (email.trim() || fieldValue("email").trim());
    logLine(`[login] submit mode=${mode} account=${account ? "有" : "空"} pass=${pass ? "有" : "空"}`);
    if (!account || !pass) { setErr("请输入账号与密码"); return; }
    pending.current = true;
    setBusy(true); setErr("");
    const started = context.current;
    const epoch = requestEpoch.current;
    const task = mode === "login" ? api.login(account, pass) : api.register(account, pass, mail);
    /* 超时 ≠ 失败：Rust 侧 api_login/api_register 在**写令牌成功之后**才返回
       （api.rs 的 set_if_revision），15s 的界面死线只说明「回包慢了」，令牌可能已经
       写进去了。旧代码超时直接走失败分支、不 setUser，于是界面还是游客、后续请求却带着
       这个令牌。这里超时后主动核对会话：真的登录了就补 setUser，让界面和令牌一致。 */
    const reconcile = async (): Promise<boolean> => {
      if (epoch !== requestEpoch.current || started.lineEpoch !== context.current.lineEpoch) return false;
      try {
        const session = await api.boot();
        const next = session?.user && Number.isSafeInteger((session.user as User).id) && (session.user as User).id > 0
          ? session.user as User : null;
        if (!session?.logged_in || !next) return false;
        if (!mounted.current) return false;
        logLine(`[login] 超时后核对：会话实际已登录（${next.nickname || next.id}），补写界面状态`);
        setUser(next, session.base);
        setPassword("");
        setLoginOpen(false);
        beginGuestMerge();
        toast(`线路较慢，登录已确认：${next.nickname || account}`, "ok");
        return true;
      } catch { return false; }
    };
    try {
      const result = await withDeadline(task, SUBMIT_TIMEOUT_MS);
      if (!mounted.current) return;
      if (epoch !== requestEpoch.current || started.accountScope !== context.current.accountScope || started.lineEpoch !== context.current.lineEpoch) {
        setErr("账号或线路已变化，请重新登录");
        return;
      }
      logLine(`[login] 成功：${result?.user?.nickname || account}`);
      setUser(result.user as User, result.origin); setPassword(""); setLoginOpen(false);
      /* 登录后问一句：本机（游客）的收藏/观看要不要同步到账号 */
      beginGuestMerge();
      toast(mode === "login" ? `欢迎回来，${result.user?.nickname || username}` : "注册成功", "ok");
    } catch (error) {
      logLine(`[login] 失败：${(error as Error)?.message || String(error)}`.slice(0, 160));
      const timedOut = (error as Error)?.message === TIMEOUT_FLAG;
      if (timedOut) {
        /* 先核对一次（可能是上一次提交已经写入令牌）；没核对到就把迟到的那次请求当作
           权威信号——它 resolve 说明 Rust 真的写成功了，那一刻立刻补 setUser。 */
        const settled = await reconcile();
        if (!settled) {
          void task.then(() => reconcile(), () => { /* 真失败：什么都没写，保持游客态 */ });
          if (mounted.current) setErr(loginErrorMessage(error));
        }
      } else if (mounted.current) setErr(loginErrorMessage(error));
    }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const content = <div className="ios-auth">
    <div className="ios-dialog-heading"><span className="ios-heading-icon"><ILogin size={21} /></span><h2>{title}</h2>
      <Button className="ios-icon-button" aria-label="关闭登录" onClick={close} disabled={busy}><IClose size={19} /></Button>
    </div>
    <p className="ios-description">登录后同步账号收藏、关注和观看记录；游客的本机记录单独保留。</p>
    <SegmentedControl className="ios-auth-tabs" aria-label="账号操作" activeIndex={mode === "login" ? 0 : 1}>
      {([ ["login", "登录"], ["register", "注册"] ] as const).map(([key, label]) => <Button key={key}
        /* 分段控件里的「登录」和底部提交按钮的「登录」是同名不同物：
           以前两者在 DOM 里都只叫「登录」，自动化/读屏分不清，文本选择器会命中"当前已选中的标签页"，
           点下去当然没有任何反应（v3.0.6 真机"隐藏的登录 UI 可被命中"其实就是这个）。
           这里给标签页一个独立的名字，提交按钮保持「登录」。 */
        role="tab" aria-selected={mode === key} aria-label={`切换到${label}`}
        disabled={busy} aria-pressed={mode === key} onClick={() => { if (!pending.current) { setMode(key); setErr(""); setShowPassword(false); } }}>{label}</Button>)}
    </SegmentedControl>
    <Form ref={formRef} className="ios-auth-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="ios-field"><span>账号</span><Input aria-label="账号" data-autofocus autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} readOnly={busy} name="username" placeholder="输入账号" value={username}
        onChange={event => setUsername(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} /></label>
      <div className="ios-field"><span id={passwordId}>密码</span><div className="relative">
        <Input aria-label="密码" aria-labelledby={passwordId} autoComplete={mode === "login" ? "current-password" : "new-password"} name="password" type={showPassword ? "text" : "password"} readOnly={busy}
          style={{ paddingRight: 56 }} placeholder="输入密码" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} />
        <Button className="ios-icon-button absolute right-1 top-1/2 -translate-y-1/2 text-mut" aria-label={showPassword ? "隐藏密码" : "显示密码"}
          aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(value => !value)}>{showPassword ? <IEyeOff size={20} /> : <IEye size={20} />}</Button>
      </div></div>
      {mode === "register" && <label className="ios-field"><span>邮箱 <small>可选</small></span><Input aria-label="邮箱" type="email" autoComplete="email" readOnly={busy} name="email"
        placeholder="用于账号联系" value={email} onChange={event => setEmail(event.target.value)} /></label>}
      {err && <p id={errorId} role="alert" className="ios-field-error">{err}</p>}
      {(busy || slowSubmit) && !err && (
        <p className="ios-field-status" role="status">
          {busy
            ? (slowSubmit ? "还在等线路响应…网络慢时可以在「设置 · 网络」换一条线路" : "正在提交…")
            : "上一次提交还没有返回，请稍候；一直不动可以关掉面板重开"}
        </p>
      )}
      <Button variant="primary" className="ios-auth-submit" type="submit" disabled={busy}>
        {busy && <Loader className="size-5" />}{busy ? "处理中…" : mode === "login" ? "登录" : "创建账号"}
      </Button>
    </Form>
    <p className="ios-description ios-auth-note">登录状态与当前站点绑定；使用自定义镜像时，登录请求会发送到你填写的站点，跨站点切换需重新登录。</p>
  </div>;
  return isMobile ? /* 安卓：软键盘弹出时面板要自己把输入框/提交按钮留在可视区（上游 205eb02）。 */
    <Sheet open={loginOpen} onClose={close} label={title} avoidNativeKeyboard={isAndroid}>{content}</Sheet>
    : <Modal open={loginOpen} onClose={close} label={title} width={440}>{content}</Modal>;
}
