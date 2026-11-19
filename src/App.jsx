import { useCallback, useEffect, useMemo, useState } from "react";
import { api, jsonBody } from "./api.js";

const sections = [
  { id: "dashboard", label: "Dashboard", icon: "⌂" },
  { id: "patients", label: "Patients", icon: "♧" },
  { id: "prescriptions", label: "Prescriptions", icon: "▤" },
  { id: "reminders", label: "Reminders", icon: "◷" }
];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
const emptyData = { patients: [], prescriptions: [], reminders: [] };

export default function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem("medisense-session") || "null"); } catch { return null; }
  });
  const [page, setPage] = useState("dashboard");
  const [data, setData] = useState(emptyData);
  const [dashboard, setDashboard] = useState(null);
  const [logs, setLogs] = useState([]);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [pushState, setPushState] = useState("Checking notification support…");

  const token = session?.token;
  const refresh = useCallback(async () => {
    if (!token) return;
    const [patientsResult, prescriptionsResult, remindersResult, dashboardResult, logsResult] = await Promise.all([
      api("/patients", { token }), api("/prescriptions", { token }), api("/reminders", { token }),
      api("/dashboard", { token }), api("/notifications/logs", { token })
    ]);
    setData({ patients: patientsResult.patients, prescriptions: prescriptionsResult.prescriptions, reminders: remindersResult.reminders });
    setDashboard(dashboardResult);
    setLogs(logsResult.logs);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refresh().catch((reason) => setError(reason.message));
  }, [token, refresh]);

  useEffect(() => {
    const expired = () => {
      void unsubscribeLocalPush().catch((reason) => setError(`Could not stop browser push notifications: ${reason.message}`));
      clearSession();
      setError("Your session expired. Please sign in again.");
    };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);

  useEffect(() => {
    const changed = (event) => {
      if (event.key === "medisense-session") {
        clearSession();
        setError("Your session changed in another tab. Please sign in again.");
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const checkSupport = async () => {
      if (!("serviceWorker" in navigator) || !("Notification" in window)) {
        setPushState("This browser does not support web notifications.");
        return;
      }
      try {
        await navigator.serviceWorker.register("/sw.js");
        const keyResult = await api("/push/public-key", { token });
        if (keyResult.publicKey) {
          setPushState(Notification.permission === "granted" ? "Browser notifications are ready." : "Browser notifications are available.");
        } else {
          setPushState("On-screen reminders work while open. Add VAPID keys for notifications when closed.");
        }
      } catch (reason) {
        if (active) setPushState(`Notifications unavailable: ${reason.message}`);
      }
    };
    checkSupport();
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!token || !("Notification" in window)) return;
    let active = true;
    const cursorKey = `medisense-notification-cursor-${session.user.id}`;
    const savedCursor = localStorage.getItem(cursorKey);
    let cursor = savedCursor === null ? null : Number(savedCursor);
    const poll = async () => {
      try {
        const result = await api(`/notifications${cursor === null ? "" : `?afterId=${cursor}`}`, { token });
        for (const log of result.logs) {
          if (!active || log.id <= cursor) continue;
          const [date, time] = log.scheduledFor.split("T");
          const message = log.message;
          if (Notification.permission === "granted") {
            const registration = await navigator.serviceWorker.ready;
            await registration.showNotification("Medicine reminder", {
                body: message, tag: `medicine-${log.reminderId}-${date}-${time?.slice(0, 5) || ""}`, icon: "/medicine-icon.svg"
            });
          }
          cursor = log.id;
          localStorage.setItem(cursorKey, String(cursor));
        }
      } catch (reason) {
        if (active) console.error("Could not check medicine reminders:", reason);
      }
    };
    void poll();
    const interval = window.setInterval(poll, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, [session?.user?.id, token]);

  async function authenticate(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const result = await api(`/auth/${authMode === "register" ? "register" : "login"}`, { method: "POST", body: jsonBody(payload) });
      localStorage.setItem("medisense-session", JSON.stringify(result));
      setSession(result);
      setError("");
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  function clearSession() {
    localStorage.removeItem("medisense-session");
    setSession(null);
    setData(emptyData);
    setDashboard(null);
    setPage("dashboard");
  }

  async function logout() {
    let pushError = "";
    try {
      const endpoint = await unsubscribeLocalPush();
      if (endpoint && token) {
        await api("/push/subscribe", { token, method: "DELETE", body: jsonBody({ endpoint }) });
      }
    } catch (reason) {
      pushError = `Could not remove the browser push subscription: ${reason.message}`;
    }
    clearSession();
    setError(pushError);
  }

  async function unsubscribeLocalPush() {
    if (!("serviceWorker" in navigator)) return null;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return null;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    return endpoint;
  }

  async function saveRecord(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(form.entries());
    let payload = values;
    if (modal.type === "patient") payload = { ...values, age: Number(values.age) };
    if (modal.type === "prescription") payload = { ...values, patientId: Number(values.patientId) };
    if (modal.type === "reminder") {
      payload = {
        prescriptionId: Number(values.prescriptionId),
        times: values.times.split(",").map((time) => time.trim()).filter(Boolean),
        days: form.getAll("days").map(Number),
        startDate: values.startDate,
        endDate: values.endDate,
        isActive: modal.record?.isActive ?? true
      };
    }
    try {
      const base = modal.type === "patient" ? "/patients" : modal.type === "prescription" ? "/prescriptions" : "/reminders";
      const edit = Boolean(modal.record);
      await api(`${base}${edit ? `/${modal.record.id}` : ""}`, {
        token, method: edit ? "PUT" : "POST", body: jsonBody(payload)
      });
      setModal(null);
      await refresh();
      setNotice(`${modal.type[0].toUpperCase()}${modal.type.slice(1)} ${edit ? "updated" : "created"}.`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecord(type, id, label) {
    if (!window.confirm(`Delete this ${label}? Related records may also be removed.`)) return;
    const path = type === "patient" ? "patients" : type === "prescription" ? "prescriptions" : "reminders";
    try {
      await api(`/${path}/${id}`, { token, method: "DELETE" });
      await refresh();
      setNotice(`${label[0].toUpperCase()}${label.slice(1)} deleted.`);
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function sendReminderSms(reminder) {
    if (!window.confirm(`Send a real SMS reminder to ${reminder.patientName}?`)) return;
    try {
      setBusy(true);
      const result = await api(`/sms/reminders/${reminder.id}/send`, { token, method: "POST", body: jsonBody({}) });
      setNotice(result.message);
      setError("");
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }

  async function toggleReminder(reminder) {
    try {
      await api(`/reminders/${reminder.id}/active`, { token, method: "PATCH", body: jsonBody({ isActive: !reminder.isActive }) });
      await refresh();
    } catch (reason) { setError(reason.message); }
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      setError("This browser does not support notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushState(permission === "denied" ? "Notifications are blocked in browser settings." : "Notification permission was not granted.");
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const keyResult = await api("/push/public-key", { token });
      if (keyResult.publicKey) {
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeKey(keyResult.publicKey)
        });
        await api("/push/subscribe", { token, method: "POST", body: jsonBody({ subscription: subscription.toJSON() }) });
        setPushState("Push reminders are enabled, including when the browser is closed.");
      } else {
        setPushState("On-screen reminders are enabled. Add VAPID keys for notifications when closed.");
      }
      setNotice("Browser notification permission enabled.");
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function disableNotifications() {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api("/push/subscribe", { token, method: "DELETE", body: jsonBody({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setPushState("Browser notifications are disabled.");
      setNotice("Browser notifications disabled.");
    } catch (reason) { setError(reason.message); }
  }

  const filteredPatients = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.patients.filter((patient) => `${patient.name} ${patient.contact}`.toLowerCase().includes(query));
  }, [data.patients, search]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!session) return <AuthPage mode={authMode} setMode={setAuthMode} onSubmit={authenticate} busy={busy} error={error} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage("dashboard"); }}>
          <span className="brand-mark">+</span><span>medisense<small>CARE, ON TIME</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {sections.map((section) => (
            <button key={section.id} className={page === section.id ? "nav-item active" : "nav-item"} onClick={() => { setPage(section.id); setError(""); }}>
              <span className="nav-icon">{section.icon}</span>{section.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note"><span>◈</span><div><b>Your workspace is private</b><small>Your patient records are only visible to your account.</small></div></div>
          <button className="nav-item logout" onClick={logout}><span className="nav-icon">↪</span>Log out</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand"><span className="brand-mark">+</span> medisense</div>
          <div className="topbar-right">
            <button className="notification-button" title={pushState} aria-label="Notification settings" onClick={"Notification" in window && Notification.permission === "granted" ? disableNotifications : enableNotifications}>♧</button>
            <div className="user-chip"><span className="avatar">{session.user.name.charAt(0).toUpperCase()}</span><div><b>{session.user.name}</b><small>Care coordinator</small></div></div>
          </div>
        </header>
        <div className="content-wrap">
          {error && <div className="alert error-alert" role="alert">{error}<button onClick={() => setError("")}>×</button></div>}
          {notice && <div className="alert success-alert" role="status">{notice}</div>}
          {page === "dashboard" && <DashboardPage dashboard={dashboard} name={session.user.name} onNavigate={setPage} pushState={pushState} enableNotifications={enableNotifications} />}
          {page === "patients" && <PatientsPage patients={filteredPatients} search={search} setSearch={setSearch} onAdd={() => setModal({ type: "patient" })} onEdit={(record) => setModal({ type: "patient", record })} onDelete={(id) => deleteRecord("patient", id, "patient")} />}
          {page === "prescriptions" && <PrescriptionsPage data={data} onAdd={() => setModal({ type: "prescription" })} onEdit={(record) => setModal({ type: "prescription", record })} onDelete={(id) => deleteRecord("prescription", id, "prescription")} />}
          {page === "reminders" && <RemindersPage data={data} logs={logs} onAdd={() => setModal({ type: "reminder" })} onEdit={(record) => setModal({ type: "reminder", record })} onDelete={(id) => deleteRecord("reminder", id, "reminder")} onToggle={toggleReminder} onEnable={enableNotifications} onSendSms={sendReminderSms} busy={busy} />}
        </div>
      </main>
      {modal && <RecordModal modal={modal} data={data} onClose={() => { setModal(null); setError(""); }} onSubmit={saveRecord} busy={busy} error={error} />}
    </div>
  );
}

function AuthPage({ mode, setMode, onSubmit, busy, error }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <a className="brand auth-brand" href="#"><span className="brand-mark">+</span><span>medisense<small>CARE, ON TIME</small></span></a>
        <div className="auth-heading"><span className="eyebrow">PATIENT MEDICINE REMINDERS</span><h1>{mode === "register" ? "Create your account" : "Welcome back"}</h1><p>{mode === "register" ? "A calmer, more organized way to manage care." : "Sign in to manage your patients and medicine schedules."}</p></div>
        {error && <div className="alert error-alert" role="alert">{error}</div>}
        <form className="form-stack" onSubmit={onSubmit}>
          {mode === "register" && <Field label="Your name" name="name" placeholder="e.g. Alex Morgan" autoComplete="name" required />}
          <Field label="Email address" name="email" type="email" placeholder="you@example.com" autoComplete="email" required />
          <Field label="Password" name="password" type="password" placeholder="At least 8 characters" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={8} required />
          {mode === "register" && <Field label="Confirm password" name="confirmPassword" type="password" placeholder="Enter your password again" autoComplete="new-password" minLength={8} required />}
          <button className="button primary full-width" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"} <span>→</span></button>
        </form>
        <p className="auth-switch">{mode === "register" ? "Already have an account?" : "New to medisense?"} <button onClick={() => setMode(mode === "register" ? "login" : "register")}>{mode === "register" ? "Sign in" : "Create an account"}</button></p>
        <div className="auth-footnote">Your health data is private and protected.</div>
      </section>
    </main>
  );
}

function DashboardPage({ dashboard, name, onNavigate, pushState, enableNotifications }) {
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return (
    <>
      <div className="page-heading dashboard-heading"><div><span className="eyebrow">{dateLabel.toUpperCase()}</span><h1>Good care starts here, {name.split(" ")[0]}.</h1><p>Here’s your care overview for today.</p></div><button className="button secondary" onClick={enableNotifications}>♧ &nbsp;Enable notifications</button></div>
      {!dashboard && <div className="loading-card">Loading your workspace…</div>}
      {dashboard && <>
        <div className="stats-grid">
          <StatCard label="Total patients" value={dashboard.counts.patients} helper="Patients in your workspace" icon="♧" tone="blue" onClick={() => onNavigate("patients")} />
          <StatCard label="Prescriptions" value={dashboard.counts.prescriptions} helper="Active care records" icon="▤" tone="teal" onClick={() => onNavigate("prescriptions")} />
          <StatCard label="Upcoming reminders" value={dashboard.upcomingReminders} helper="Doses still scheduled today" icon="◷" tone="peach" onClick={() => onNavigate("reminders")} />
          <StatCard label="Today's medicines" value={dashboard.todayMedicines.length} helper="Scheduled doses for today" icon="✚" tone="lavender" onClick={() => onNavigate("reminders")} />
        </div>
        <section className="panel today-panel">
          <div className="panel-heading"><div><h2>Today’s medicine schedule</h2><p>Only reminders scheduled for today are shown.</p></div><button className="text-button" onClick={() => onNavigate("reminders")}>Manage reminders <span>→</span></button></div>
          {dashboard.todayMedicines.length ? <div className="schedule-list">{dashboard.todayMedicines.map((item, index) => <div className="schedule-item" key={`${item.id}-${item.time}-${index}`}>
            <span className="schedule-time">{item.time}</span><span className="schedule-icon">✚</span><div className="schedule-info"><b>{item.medicineName}</b><span>{item.dosage} · {item.patientName}</span></div><span className="frequency-chip">{item.isActive ? "Scheduled" : "Inactive"}</span>
          </div>)}</div> : <EmptyState icon="◷" title="No medicines scheduled today" text="Add a prescription and create a reminder to see today's doses here." action="Create a reminder" onClick={() => onNavigate("reminders")} />}
        </section>
        <div className="dashboard-bottom">
          <section className="panel quick-panel"><div className="panel-heading"><div><h2>Quick actions</h2><p>Keep care plans up to date.</p></div></div>
            <button className="quick-action" onClick={() => onNavigate("patients")}><span className="quick-icon blue">♧</span><span><b>Manage patients</b><small>Add or update patient details</small></span><i>→</i></button>
            <button className="quick-action" onClick={() => onNavigate("prescriptions")}><span className="quick-icon teal">▤</span><span><b>Review prescriptions</b><small>Keep medicine records current</small></span><i>→</i></button>
          </section>
          <section className="notification-card"><span className="notification-art">◷</span><span className="eyebrow">NEVER MISS A DOSE</span><h2>Reminders that fit your day.</h2><p>{pushState}</p><button className="button white-button" onClick={enableNotifications}>Set up notifications <span>→</span></button></section>
        </div>
      </>}
    </>
  );
}

function StatCard({ label, value, helper, icon, tone, onClick }) {
  return <button className="stat-card" onClick={onClick}><span className={`stat-icon ${tone}`}>{icon}</span><span className="stat-label">{label}</span><b className="stat-value">{value}</b><span className="stat-helper">{helper}</span></button>;
}

function PatientsPage({ patients, search, setSearch, onAdd, onEdit, onDelete }) {
  return <><PageTitle eyebrow="CARE DIRECTORY" title="Patients" description="Keep patient details and care notes in one place." action="Add patient" onAction={onAdd} />
    <section className="panel table-panel"><div className="table-toolbar"><div><h2>All patients</h2><p>{patients.length} patient{patients.length === 1 ? "" : "s"}</p></div><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patients…" aria-label="Search patients" /></label></div>
      {patients.length ? <div className="table-scroll"><table><thead><tr><th>Patient</th><th>Age / gender</th><th>Contact</th><th>Address</th><th>Medical notes</th><th /></tr></thead><tbody>
        {patients.map((patient) => <tr key={patient.id}><td><div className="table-person"><span className="avatar">{patient.name.charAt(0).toUpperCase()}</span><b>{patient.name}</b></div></td><td>{patient.age} · {patient.gender}</td><td>{patient.contact}</td><td>{patient.address}</td><td className="notes-cell">{patient.medicalNotes || "—"}</td><td><RowActions onEdit={() => onEdit(patient)} onDelete={() => onDelete(patient.id)} /></td></tr>)}
      </tbody></table></div> : <EmptyState icon="♧" title={search ? "No patients found" : "No patients yet"} text={search ? "Try a different name or contact detail." : "Add a patient to start organizing their care."} action={search ? undefined : "Add first patient"} onClick={onAdd} />}
    </section>
  </>;
}

function PrescriptionsPage({ data, onAdd, onEdit, onDelete }) {
  return <><PageTitle eyebrow="MEDICINE RECORDS" title="Prescriptions" description="Manage medicines and instructions for each patient." action="Add prescription" onAction={onAdd} />
    <section className="panel table-panel"><div className="table-toolbar"><div><h2>All prescriptions</h2><p>{data.prescriptions.length} prescription{data.prescriptions.length === 1 ? "" : "s"}</p></div></div>
      {data.prescriptions.length ? <div className="table-scroll"><table><thead><tr><th>Medicine</th><th>Patient</th><th>Dosage</th><th>Frequency</th><th>Dates</th><th>Instructions</th><th /></tr></thead><tbody>
        {data.prescriptions.map((item) => <tr key={item.id}><td><b>{item.medicineName}</b></td><td>{item.patientName}</td><td>{item.dosage}</td><td>{item.frequency}</td><td>{item.startDate}<br /><span className="muted">to {item.endDate}</span></td><td className="notes-cell">{item.instructions || "—"}</td><td><RowActions onEdit={() => onEdit(item)} onDelete={() => onDelete(item.id)} /></td></tr>)}
      </tbody></table></div> : <EmptyState icon="▤" title="No prescriptions yet" text={data.patients.length ? "Create a prescription and link it to a patient." : "Add a patient first, then create their prescription."} action={data.patients.length ? "Add prescription" : undefined} onClick={onAdd} />}
    </section>
  </>;
}

function RemindersPage({ data, logs, onAdd, onEdit, onDelete, onToggle, onEnable, onSendSms, busy }) {
  return <><PageTitle eyebrow="SCHEDULED CARE" title="Reminders" description="Set reliable dose times and choose the days they repeat." action="Create reminder" onAction={onAdd} />
    <section className="panel table-panel"><div className="table-toolbar"><div><h2>Your reminders</h2><p>{data.reminders.length} reminder{data.reminders.length === 1 ? "" : "s"}</p></div><button className="button secondary small-button" onClick={onEnable}>♧ &nbsp;Notification settings</button></div>
      {data.reminders.length ? <div className="reminder-grid">{data.reminders.map((item) => <article className={`reminder-card ${!item.isActive ? "inactive" : ""}`} key={item.id}>
        <div className="reminder-card-top"><span className="schedule-icon">✚</span><span className={item.isActive ? "status-pill active-pill" : "status-pill"}>{item.isActive ? "Active" : "Paused"}</span></div>
        <h3>{item.medicineName}</h3><p className="reminder-patient">{item.patientName} · {item.dosage}</p>
        <div className="reminder-times">{item.times.map((time) => <span key={time}>◷ &nbsp;{time}</span>)}</div>
        <div className="reminder-days">{weekdays.map((day, index) => <span key={day} className={item.days.includes(index) ? "day active-day" : "day"}>{day[0]}</span>)}</div>
        <div className="reminder-dates">{item.startDate} — {item.endDate}</div>
        <div className="reminder-actions"><button disabled={busy} className="button secondary small-button" onClick={() => onSendSms(item)}>Send SMS</button><button className="text-button" onClick={() => onToggle(item)}>{item.isActive ? "Pause" : "Activate"}</button><RowActions onEdit={() => onEdit(item)} onDelete={() => onDelete(item.id)} /></div>
      </article>)}</div> : <EmptyState icon="◷" title="No reminders set up" text={data.prescriptions.length ? "Create a schedule for one of your prescriptions." : "Create a prescription before setting a reminder."} action={data.prescriptions.length ? "Create first reminder" : undefined} onClick={onAdd} />}
    </section>
    <section className="panel log-panel"><div className="panel-heading"><div><h2>Notification log</h2><p>Reminder events (sent means processed/queued, not confirmed SMS delivery).</p></div></div>
      {logs.length ? <div className="log-list">{logs.map((log) => <div className="log-row" key={log.id}><span className={`log-status ${log.status}`}>{log.status === "sent" ? "Processed" : log.status === "missed" ? "Missed" : "Failed"}</span><div><b>{log.medicineName} · {log.patientName}</b><small>{log.message}</small></div><time>{new Date(log.scheduledFor.replace(" ", "T")).toLocaleString()}</time></div>)}</div> : <p className="empty-log">No notification events have been recorded yet.</p>}
    </section>
  </>;
}

function PageTitle({ eyebrow, title, description, action, onAction }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><button className="button primary" onClick={onAction}><span>＋</span> {action}</button></div>;
}

function RowActions({ onEdit, onDelete }) {
  return <div className="row-actions"><button title="Edit" aria-label="Edit" onClick={onEdit}>✎</button><button title="Delete" aria-label="Delete" onClick={onDelete}>×</button></div>;
}

function EmptyState({ icon, title, text, action, onClick }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{text}</p>{action && <button className="button secondary" onClick={onClick}>{action}</button>}</div>;
}

function RecordModal({ modal, data, onClose, onSubmit, busy, error }) {
  const editing = modal.record;
  const patient = editing || {};
  const prescription = editing || {};
  const reminder = editing || {};
  const [selectedPrescriptionId, setSelectedPrescriptionId] = useState(reminder.prescriptionId || data.prescriptions[0]?.id || "");
  const selectedPrescription = data.prescriptions.find((item) => item.id === Number(selectedPrescriptionId));
  const [reminderStart, setReminderStart] = useState(reminder.startDate || selectedPrescription?.startDate || today());
  const [reminderEnd, setReminderEnd] = useState(reminder.endDate || selectedPrescription?.endDate || today());
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-heading"><div><span className="eyebrow">{editing ? "UPDATE DETAILS" : "NEW RECORD"}</span><h2 id="modal-title">{editing ? "Edit" : "Add"} {modal.type}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
      {error && <div className="alert error-alert" role="alert">{error}</div>}
      <form className="form-stack modal-form" onSubmit={onSubmit}>
        {modal.type === "patient" && <>
          <Field label="Full name" name="name" defaultValue={patient.name} required />
          <div className="form-row"><Field label="Age" name="age" type="number" min="0" max="130" defaultValue={patient.age} required /><label className="field"><span>Gender</span><select name="gender" defaultValue={patient.gender || ""} required><option value="" disabled>Select gender</option>{["Female", "Male", "Non-binary", "Prefer not to say", "Other"].map((item) => <option key={item}>{item}</option>)}</select></label></div>
          <Field label="Contact" name="contact" defaultValue={patient.contact} placeholder="Phone number or email" required />
          <Field label="Address" name="address" defaultValue={patient.address} required />
          <label className="field"><span>Medical notes <small>(optional)</small></span><textarea name="medicalNotes" defaultValue={patient.medicalNotes} rows="3" placeholder="Relevant allergies or care notes" /></label>
        </>}
        {modal.type === "prescription" && <>
          {data.patients.length ? <label className="field"><span>Patient</span><select name="patientId" defaultValue={prescription.patientId || ""} required><option value="" disabled>Select patient</option>{data.patients.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label> : <div className="alert error-alert">Add a patient before creating a prescription.</div>}
          <Field label="Medicine name" name="medicineName" defaultValue={prescription.medicineName} required />
          <div className="form-row"><Field label="Dosage" name="dosage" defaultValue={prescription.dosage} placeholder="e.g. 1 tablet" required /><Field label="Frequency" name="frequency" defaultValue={prescription.frequency} placeholder="e.g. Twice daily" required /></div>
          <div className="form-row"><Field label="Start date" name="startDate" type="date" defaultValue={prescription.startDate || today()} required /><Field label="End date" name="endDate" type="date" defaultValue={prescription.endDate || today()} required /></div>
          <label className="field"><span>Instructions <small>(optional)</small></span><textarea name="instructions" defaultValue={prescription.instructions} rows="3" placeholder="e.g. Take with food" /></label>
        </>}
        {modal.type === "reminder" && <>
          {data.prescriptions.length ? <label className="field"><span>Prescription</span><select name="prescriptionId" value={selectedPrescriptionId} onChange={(event) => {
            const selected = data.prescriptions.find((item) => item.id === Number(event.target.value));
            setSelectedPrescriptionId(event.target.value);
            if (selected) {
              setReminderStart(selected.startDate);
              setReminderEnd(selected.endDate);
            }
          }} required><option value="" disabled>Select prescription</option>{data.prescriptions.map((item) => <option value={item.id} key={item.id}>{item.medicineName} · {item.patientName}</option>)}</select></label> : <div className="alert error-alert">Add a prescription before creating a reminder.</div>}
          <label className="field"><span>Reminder times <small>(24-hour time, comma-separated)</small></span><input name="times" defaultValue={reminder.times?.join(", ") || "08:00"} placeholder="08:00, 13:00, 20:00" required pattern="([01][0-9]|2[0-3]):[0-5][0-9](,\\s*([01][0-9]|2[0-3]):[0-5][0-9])*" /><small>Enter each exact time, separated by commas.</small></label>
          <fieldset className="days-field"><legend>Repeat on</legend><div className="weekday-options">{weekdays.map((day, index) => <label key={day}><input type="checkbox" name="days" value={index} defaultChecked={reminder.days ? reminder.days.includes(index) : true} /><span>{day}</span></label>)}</div></fieldset>
          <div className="form-row"><Field label="Start date" name="startDate" type="date" value={reminderStart} onChange={(event) => setReminderStart(event.target.value)} required /><Field label="End date" name="endDate" type="date" value={reminderEnd} onChange={(event) => setReminderEnd(event.target.value)} required /></div>
        </>}
        <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy || (modal.type === "prescription" && !data.patients.length) || (modal.type === "reminder" && !data.prescriptions.length)}>{busy ? "Saving…" : editing ? "Save changes" : `Create ${modal.type}`}</button></div>
      </form>
    </section>
  </div>;
}

function Field({ label, name, type = "text", defaultValue, value, onChange, placeholder, required, autoComplete, min, max, minLength }) {
  return <label className="field"><span>{label}</span><input name={name} type={type} defaultValue={value === undefined ? defaultValue : undefined} value={value} onChange={onChange} placeholder={placeholder} required={required} autoComplete={autoComplete} min={min} max={max} minLength={minLength} /></label>;
}

function decodeKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
