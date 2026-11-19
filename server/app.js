import express from "express";
import bcrypt from "bcryptjs";
import webpush from "web-push";
import { db } from "./db.js";
import { createToken, requireAuth } from "./auth.js";
import { date, optionalText, text } from "./validation.js";
import { startReminderScheduler } from "./scheduler.js";
import { sendTextbeeSms, smsConfigured, medicineSms } from "./textbee.js";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  if (req.body === null || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object." });
  }
  return next();
});

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);
if (pushConfigured) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", vapidPublicKey, vapidPrivateKey);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok", pushConfigured }));
app.get("/api/push/public-key", (_req, res) => res.json({ publicKey: pushConfigured ? vapidPublicKey : null }));

app.post("/api/auth/register", (req, res, next) => {
  try {
    const name = text(req.body.name, "Name", 100);
    const email = text(req.body.email, "Email", 254).toLowerCase();
    const password = req.body.password;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (typeof password !== "string" || password.length < 8 || password.length > 72) {
      return res.status(400).json({ error: "Password must be between 8 and 72 characters." });
    }
    if (req.body.confirmPassword !== password) return res.status(400).json({ error: "Passwords do not match." });
    const result = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run(name, email, bcrypt.hashSync(password, 12));
    const user = { id: Number(result.lastInsertRowid), name, email };
    return res.status(201).json({ token: createToken(user), user });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "An account with this email already exists." });
    return next(error);
  }
});

app.post("/api/auth/login", (req, res, next) => {
  try {
    const email = text(req.body.email, "Email", 254).toLowerCase();
    const password = req.body.password;
    const user = db.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?").get(email);
    if (!user || typeof password !== "string" || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    return res.json({ token: createToken(user), user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    return next(error);
  }
});

app.use("/api", requireAuth);

app.get("/api/sms/status", (_req, res) => res.json({ configured: smsConfigured() }));
app.post("/api/sms/reminders/:id/send", async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    const row = db.prepare(`SELECT r.id, r.times, pr.medicine_name AS medicineName, pr.dosage,
      p.name AS patientName, p.contact FROM reminders r
      JOIN prescriptions pr ON pr.id = r.prescription_id AND pr.user_id = r.user_id
      JOIN patients p ON p.id = pr.patient_id AND p.user_id = r.user_id
      WHERE r.id = ? AND r.user_id = ?`).get(id, req.userId);
    if (!row) return res.status(404).json({ error: "Reminder not found." });
    const time = localTime();
    const message = medicineSms(row, time);
    const result = await sendTextbeeSms({ phone: row.contact, message });
    return res.json({ message: "SMS queued on textbee (not yet confirmed delivered).", batchId: result.batchId });
  } catch (error) { return res.status(400).json({ error: error.message }); }
});

app.get("/api/auth/me", (req, res) => {
  const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(req.userId);
  return user ? res.json({ user }) : res.status(401).json({ error: "Account not found." });
});

const patientColumns = "id, name, age, gender, contact, address, medical_notes AS medicalNotes";
app.get("/api/patients", (req, res) => {
  const search = String(req.query.search || "").trim();
  const patients = search
    ? db.prepare(`SELECT ${patientColumns} FROM patients WHERE user_id = ? AND (name LIKE ? OR contact LIKE ?) ORDER BY name`).all(req.userId, `%${search}%`, `%${search}%`)
    : db.prepare(`SELECT ${patientColumns} FROM patients WHERE user_id = ? ORDER BY name`).all(req.userId);
  return res.json({ patients });
});

app.post("/api/patients", (req, res) => {
  const data = parsePatient(req.body);
  const result = db.prepare("INSERT INTO patients (user_id, name, age, gender, contact, address, medical_notes) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(req.userId, data.name, data.age, data.gender, data.contact, data.address, data.medicalNotes);
  return res.status(201).json({ patient: getPatient(req.userId, Number(result.lastInsertRowid)) });
});

app.put("/api/patients/:id", (req, res) => {
  const id = positiveId(req.params.id);
  const data = parsePatient(req.body);
  const result = db.prepare("UPDATE patients SET name = ?, age = ?, gender = ?, contact = ?, address = ?, medical_notes = ? WHERE id = ? AND user_id = ?")
    .run(data.name, data.age, data.gender, data.contact, data.address, data.medicalNotes, id, req.userId);
  return result.changes ? res.json({ patient: getPatient(req.userId, id) }) : res.status(404).json({ error: "Patient not found." });
});

app.delete("/api/patients/:id", (req, res) => {
  const result = db.prepare("DELETE FROM patients WHERE id = ? AND user_id = ?").run(positiveId(req.params.id), req.userId);
  return result.changes ? res.status(204).end() : res.status(404).json({ error: "Patient not found." });
});

const prescriptionSelect = `SELECT pr.id, pr.patient_id AS patientId, p.name AS patientName, pr.medicine_name AS medicineName,
  pr.dosage, pr.frequency, pr.start_date AS startDate, pr.end_date AS endDate, pr.instructions
  FROM prescriptions pr JOIN patients p ON p.id = pr.patient_id AND p.user_id = pr.user_id`;
app.get("/api/prescriptions", (req, res) => {
  return res.json({ prescriptions: db.prepare(`${prescriptionSelect} WHERE pr.user_id = ? ORDER BY pr.start_date DESC, pr.id DESC`).all(req.userId) });
});
app.post("/api/prescriptions", (req, res) => {
  const data = parsePrescription(req.body, req.userId);
  const result = db.prepare(`INSERT INTO prescriptions
    (user_id, patient_id, medicine_name, dosage, frequency, start_date, end_date, instructions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(req.userId, data.patientId, data.medicineName, data.dosage, data.frequency, data.startDate, data.endDate, data.instructions);
  return res.status(201).json({ prescription: getPrescription(req.userId, Number(result.lastInsertRowid)) });
});
app.put("/api/prescriptions/:id", (req, res) => {
  const id = positiveId(req.params.id);
  const data = parsePrescription(req.body, req.userId);
  const result = db.prepare(`UPDATE prescriptions SET patient_id = ?, medicine_name = ?, dosage = ?, frequency = ?,
    start_date = ?, end_date = ?, instructions = ? WHERE id = ? AND user_id = ?`)
    .run(data.patientId, data.medicineName, data.dosage, data.frequency, data.startDate, data.endDate, data.instructions, id, req.userId);
  return result.changes ? res.json({ prescription: getPrescription(req.userId, id) }) : res.status(404).json({ error: "Prescription not found." });
});
app.delete("/api/prescriptions/:id", (req, res) => {
  const result = db.prepare("DELETE FROM prescriptions WHERE id = ? AND user_id = ?").run(positiveId(req.params.id), req.userId);
  return result.changes ? res.status(204).end() : res.status(404).json({ error: "Prescription not found." });
});

const reminderSelect = `SELECT r.id, r.prescription_id AS prescriptionId, pr.medicine_name AS medicineName, pr.dosage,
  p.name AS patientName, r.times, r.days, r.start_date AS startDate, r.end_date AS endDate, r.is_active AS isActive
  FROM reminders r JOIN prescriptions pr ON pr.id = r.prescription_id AND pr.user_id = r.user_id
  JOIN patients p ON p.id = pr.patient_id AND p.user_id = pr.user_id`;
app.get("/api/reminders", (req, res) => {
  const reminders = db.prepare(`${reminderSelect} WHERE r.user_id = ? ORDER BY r.is_active DESC, r.id DESC`).all(req.userId).map(parseReminderRow);
  return res.json({ reminders });
});
app.post("/api/reminders", (req, res) => {
  const data = parseReminder(req.body, req.userId);
  const result = db.prepare(`INSERT INTO reminders (user_id, prescription_id, times, days, start_date, end_date, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.userId, data.prescriptionId, JSON.stringify(data.times), JSON.stringify(data.days), data.startDate, data.endDate, data.isActive);
  return res.status(201).json({ reminder: getReminder(req.userId, Number(result.lastInsertRowid)) });
});
app.put("/api/reminders/:id", (req, res) => {
  const id = positiveId(req.params.id);
  const data = parseReminder(req.body, req.userId);
  const result = db.prepare(`UPDATE reminders SET prescription_id = ?, times = ?, days = ?, start_date = ?, end_date = ?, is_active = ?
    WHERE id = ? AND user_id = ?`).run(data.prescriptionId, JSON.stringify(data.times), JSON.stringify(data.days), data.startDate, data.endDate, data.isActive, id, req.userId);
  return result.changes ? res.json({ reminder: getReminder(req.userId, id) }) : res.status(404).json({ error: "Reminder not found." });
});
app.patch("/api/reminders/:id/active", (req, res) => {
  if (typeof req.body.isActive !== "boolean") return res.status(400).json({ error: "isActive must be a boolean." });
  const id = positiveId(req.params.id);
  const result = db.prepare("UPDATE reminders SET is_active = ? WHERE id = ? AND user_id = ?").run(Number(req.body.isActive), id, req.userId);
  return result.changes ? res.json({ reminder: getReminder(req.userId, id) }) : res.status(404).json({ error: "Reminder not found." });
});
app.delete("/api/reminders/:id", (req, res) => {
  const result = db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(positiveId(req.params.id), req.userId);
  return result.changes ? res.status(204).end() : res.status(404).json({ error: "Reminder not found." });
});

app.get("/api/dashboard", (req, res) => {
  const counts = {
    patients: db.prepare("SELECT COUNT(*) AS count FROM patients WHERE user_id = ?").get(req.userId).count,
    prescriptions: db.prepare("SELECT COUNT(*) AS count FROM prescriptions WHERE user_id = ?").get(req.userId).count,
    reminders: db.prepare("SELECT COUNT(*) AS count FROM reminders WHERE user_id = ? AND is_active = 1").get(req.userId).count
  };
  const today = localDate();
  const todayRows = db.prepare(`${reminderSelect} WHERE r.user_id = ? AND r.is_active = 1
    AND r.start_date <= ? AND r.end_date >= ? AND pr.start_date <= ? AND pr.end_date >= ?`)
    .all(req.userId, today, today, today, today).map(parseReminderRow)
    .filter((reminder) => reminder.days.includes(new Date().getDay()))
    .flatMap((reminder) => reminder.times.map((time) => ({ ...reminder, time })))
    .sort((a, b) => a.time.localeCompare(b.time));
  const upcomingReminders = todayRows.filter((item) => item.time >= localTime()).length;
  return res.json({ counts, upcomingReminders, todayMedicines: todayRows, today });
});

app.get("/api/notifications", (req, res) => {
  const afterId = req.query.afterId;
  const cursor = afterId === undefined ? null : Number(afterId);
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("afterId must be a non-negative integer.");
  const logs = cursor !== null
    ? db.prepare(`SELECT id, reminder_id AS reminderId, scheduled_for AS scheduledFor, status, message
      FROM notification_logs WHERE user_id = ? AND status IN ('sent', 'failed') AND id > ? ORDER BY id`)
      .all(req.userId, cursor)
    : db.prepare(`SELECT id, reminder_id AS reminderId, scheduled_for AS scheduledFor, status, message
      FROM notification_logs WHERE user_id = ? AND status IN ('sent', 'failed') AND created_at >= datetime('now', '-2 minutes') ORDER BY id`).all(req.userId);
  return res.json({ logs });
});
app.get("/api/notifications/logs", (req, res) => {
  const logs = db.prepare(`SELECT nl.id, nl.reminder_id AS reminderId, nl.scheduled_for AS scheduledFor, nl.status, nl.message,
    pr.medicine_name AS medicineName, p.name AS patientName
    FROM notification_logs nl JOIN reminders r ON r.id = nl.reminder_id
    JOIN prescriptions pr ON pr.id = r.prescription_id JOIN patients p ON p.id = pr.patient_id
    WHERE nl.user_id = ? ORDER BY nl.scheduled_for DESC LIMIT 100`).all(req.userId);
  return res.json({ logs });
});

app.post("/api/push/subscribe", (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: "Web Push is not configured. Set VAPID keys in .env to enable notifications while the browser is closed." });
  const subscription = req.body.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "A valid PushSubscription is required." });
  }
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, subscription) VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription`)
    .run(req.userId, subscription.endpoint, JSON.stringify(subscription));
  return res.status(201).json({ subscribed: true });
});
app.delete("/api/push/subscribe", (req, res) => {
  if (typeof req.body.endpoint !== "string") return res.status(400).json({ error: "Subscription endpoint is required." });
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(req.userId, req.body.endpoint);
  return res.status(204).end();
});

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ error: "Request body must be valid JSON." });
  if (error.message && !error.code && !(error instanceof TypeError)) return res.status(400).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("A valid record ID is required.");
  return id;
}
function parsePatient(body) {
  if (!(typeof body.age === "number" || (typeof body.age === "string" && /^\d+$/.test(body.age)))) {
    throw new Error("Age must be a whole number between 0 and 130.");
  }
  const age = Number(body.age);
  if (!Number.isInteger(age) || age < 0 || age > 130) throw new Error("Age must be a whole number between 0 and 130.");
  const gender = text(body.gender, "Gender", 30);
  if (!["Female", "Male", "Non-binary", "Prefer not to say", "Other"].includes(gender)) throw new Error("Select a valid gender.");
  return {
    name: text(body.name, "Name", 120), age, gender, contact: text(body.contact, "Contact", 80),
    address: text(body.address, "Address", 300), medicalNotes: optionalText(body.medicalNotes, "Medical notes")
  };
}
function parsePrescription(body, userId) {
  const patientId = positiveId(body.patientId);
  if (!db.prepare("SELECT 1 FROM patients WHERE id = ? AND user_id = ?").get(patientId, userId)) throw new Error("Select one of your patients.");
  const startDate = date(body.startDate, "Start date");
  const endDate = date(body.endDate, "End date");
  if (endDate < startDate) throw new Error("End date must be on or after the start date.");
  return {
    patientId, medicineName: text(body.medicineName, "Medicine name", 120), dosage: text(body.dosage, "Dosage", 120),
    frequency: text(body.frequency, "Frequency", 120), startDate, endDate, instructions: optionalText(body.instructions, "Instructions")
  };
}
function parseReminder(body, userId) {
  const prescriptionId = positiveId(body.prescriptionId);
  const prescription = db.prepare("SELECT start_date AS startDate, end_date AS endDate FROM prescriptions WHERE id = ? AND user_id = ?").get(prescriptionId, userId);
  if (!prescription) throw new Error("Select one of your prescriptions.");
  if (!Array.isArray(body.times) || body.times.length < 1 || body.times.length > 24) throw new Error("Add between 1 and 24 reminder times.");
  const times = [...new Set(body.times)];
  if (times.some((time) => typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error("Reminder times must use 24-hour HH:MM format.");
  if (!Array.isArray(body.days) || body.days.length < 1 || body.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new Error("Select at least one valid reminder day.");
  }
  const days = [...new Set(body.days)].sort((a, b) => a - b);
  const startDate = date(body.startDate, "Start date");
  const endDate = date(body.endDate, "End date");
  if (endDate < startDate) throw new Error("End date must be on or after the start date.");
  if (startDate < prescription.startDate || endDate > prescription.endDate) {
    throw new Error("Reminder dates must fall within the prescription dates.");
  }
  return { prescriptionId, times, days, startDate, endDate, isActive: body.isActive === false ? 0 : 1 };
}
function getPatient(userId, id) {
  return db.prepare(`SELECT ${patientColumns} FROM patients WHERE id = ? AND user_id = ?`).get(id, userId);
}
function getPrescription(userId, id) {
  return db.prepare(`${prescriptionSelect} WHERE pr.id = ? AND pr.user_id = ?`).get(id, userId);
}
function getReminder(userId, id) {
  const row = db.prepare(`${reminderSelect} WHERE r.id = ? AND r.user_id = ?`).get(id, userId);
  return row ? parseReminderRow(row) : null;
}
function parseReminderRow(row) {
  return { ...row, times: JSON.parse(row.times), days: JSON.parse(row.days), isActive: Boolean(row.isActive) };
}
function localDate(dateValue = new Date()) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function localTime(dateValue = new Date()) {
  return `${String(dateValue.getHours()).padStart(2, "0")}:${String(dateValue.getMinutes()).padStart(2, "0")}`;
}

export function createApp() {
  return app;
}

export function initScheduler() {
  startReminderScheduler({ db, webpush, pushConfigured, localDate, localTime });
}

export { db };
