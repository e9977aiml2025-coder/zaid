import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "medisense-test-"));
process.env.DATABASE_PATH = path.join(tempDir, "test.sqlite");
process.env.JWT_SECRET = "test-only-secret-that-is-long-enough-for-jwt-signing";

const { createApp, db } = await import("../server/app.js");
const { markMissedReminders, processDueReminders } = await import("../server/scheduler.js");
let server;
let baseUrl;
let userToken;
let otherToken;
let patientId;
let prescriptionId;
let reminderId;
let runDate;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function request(pathname, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}/api${pathname}`, { ...options, headers });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
const json = (body) => JSON.stringify(body);

test("auth, user-isolated CRUD, dashboard, reminders, logs, and validation", async () => {
  const registration = await request("/auth/register", {
    method: "POST",
    body: json({ name: "Care Coordinator", email: "coordinator@example.test", password: "passphrase123", confirmPassword: "passphrase123" })
  });
  assert.equal(registration.status, 201);
  userToken = registration.body.token;
  assert.equal((await request("/auth/me", { token: userToken })).body.user.email, "coordinator@example.test");
  assert.equal((await request("/auth/login", {
    method: "POST", body: json({ email: "coordinator@example.test", password: "passphrase123" })
  })).status, 200);
  assert.equal((await request("/auth/login", {
    method: "POST", body: json({ email: "coordinator@example.test", password: "incorrect-password" })
  })).status, 401);

  const duplicate = await request("/auth/register", {
    method: "POST",
    body: json({ name: "Duplicate", email: "COORDINATOR@example.test", password: "passphrase123", confirmPassword: "passphrase123" })
  });
  assert.equal(duplicate.status, 409);

  const otherRegistration = await request("/auth/register", {
    method: "POST",
    body: json({ name: "Another User", email: "another@example.test", password: "anotherpass123", confirmPassword: "anotherpass123" })
  });
  otherToken = otherRegistration.body.token;
  assert.equal((await request("/patients", { token: otherToken })).body.patients.length, 0);

  const patientResponse = await request("/patients", {
    token: userToken, method: "POST",
    body: json({ name: "Patient Example", age: 48, gender: "Other", contact: "555-0123", address: "100 Example Street", medicalNotes: "No known allergies" })
  });
  assert.equal(patientResponse.status, 201);
  patientId = patientResponse.body.patient.id;
  assert.equal(patientResponse.body.patient.medicalNotes, "No known allergies");
  assert.equal((await request("/patients?search=555-0123", { token: userToken })).body.patients.length, 1);
  assert.equal((await request("/patients?search=unknown", { token: userToken })).body.patients.length, 0);
  assert.equal((await request(`/patients/${patientId}`, {
    token: otherToken, method: "PUT",
    body: json({ name: "Other user's update", age: 48, gender: "Other", contact: "555-0000", address: "Unrelated" })
  })).status, 404);
  assert.equal((await request("/patients", { token: userToken, method: "POST", body: json({ name: "Invalid", age: 500 }) })).status, 400);

  const day = new Date();
  runDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const end = new Date(day);
  end.setDate(end.getDate() + 14);
  const endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
  const prescriptionResponse = await request("/prescriptions", {
    token: userToken, method: "POST",
    body: json({ patientId, medicineName: "Example medicine", dosage: "1 tablet", frequency: "Once daily", startDate: runDate, endDate, instructions: "Take with food" })
  });
  assert.equal(prescriptionResponse.status, 201);
  prescriptionId = prescriptionResponse.body.prescription.id;
  assert.equal((await request("/prescriptions", { token: otherToken })).body.prescriptions.length, 0);
  assert.equal((await request("/prescriptions", {
    token: userToken, method: "POST",
    body: json({ patientId, medicineName: "Wrong dates", dosage: "1", frequency: "Daily", startDate: "2026-02-31", endDate })
  })).status, 400);

  const time = `${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
  const reminderResponse = await request("/reminders", {
    token: userToken, method: "POST",
    body: json({ prescriptionId, times: [time, time], days: [day.getDay()], startDate: runDate, endDate })
  });
  assert.equal(reminderResponse.status, 201);
  reminderId = reminderResponse.body.reminder.id;
  assert.deepEqual(reminderResponse.body.reminder.times, [time]);
  const dashboard = await request("/dashboard", { token: userToken });
  assert.equal(dashboard.body.counts.patients, 1);
  assert.equal(dashboard.body.counts.prescriptions, 1);
  assert.equal(dashboard.body.todayMedicines.length, 1);

  const localDate = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const localTime = (value) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  await processDueReminders({ db, pushConfigured: false, localDate, localTime, now: day });
  await processDueReminders({ db, pushConfigured: false, localDate, localTime, now: day });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE reminder_id = ?").get(reminderId).count, 1);
  const notifications = await request("/notifications?afterId=0", { token: userToken });
  assert.equal(notifications.body.logs.length, 1);
  assert.equal((await request("/notifications", { token: otherToken })).body.logs.length, 0);

  const missedReminderResponse = await request("/reminders", {
    token: userToken, method: "POST",
    body: json({ prescriptionId, times: ["00:00"], days: [day.getDay()], startDate: runDate, endDate })
  });
  const missedReminderId = missedReminderResponse.body.reminder.id;
  const lateToday = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59);
  markMissedReminders({ db, localDate, localTime, now: lateToday });
  markMissedReminders({ db, localDate, localTime, now: lateToday });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_logs WHERE reminder_id = ? AND status = 'missed'").get(missedReminderId).count, 1);

  const patientEdit = await request(`/patients/${patientId}`, {
    token: userToken, method: "PUT",
    body: json({ name: "Updated Patient", age: 49, gender: "Other", contact: "555-9876", address: "200 New Street", medicalNotes: "" })
  });
  assert.equal(patientEdit.body.patient.name, "Updated Patient");
  const prescriptionEdit = await request(`/prescriptions/${prescriptionId}`, {
    token: userToken, method: "PUT",
    body: json({ patientId, medicineName: "Updated medicine", dosage: "2 tablets", frequency: "Twice daily", startDate: runDate, endDate, instructions: "" })
  });
  assert.equal(prescriptionEdit.body.prescription.medicineName, "Updated medicine");
  const reminderEdit = await request(`/reminders/${reminderId}`, {
    token: userToken, method: "PUT",
    body: json({ prescriptionId, times: ["09:00", "21:00"], days: [1, 3, 5], startDate: runDate, endDate })
  });
  assert.deepEqual(reminderEdit.body.reminder.times, ["09:00", "21:00"]);
  assert.equal((await request(`/reminders/${reminderId}/active`, { token: userToken, method: "PATCH", body: json({ isActive: false }) })).body.reminder.isActive, false);
  assert.equal((await request(`/reminders/${reminderId}/active`, { token: userToken, method: "PATCH", body: json({ isActive: true }) })).body.reminder.isActive, true);
  assert.equal((await request(`/reminders/${reminderId}`, { token: otherToken, method: "DELETE" })).status, 404);

  assert.equal((await request("/push/subscribe", { token: userToken, method: "POST", body: json({}) })).status, 503);
  assert.equal((await request(`/reminders/${reminderId}`, { token: userToken, method: "DELETE" })).status, 204);
  assert.equal((await request(`/prescriptions/${prescriptionId}`, { token: userToken, method: "DELETE" })).status, 204);
  assert.equal((await request(`/patients/${patientId}`, { token: userToken, method: "DELETE" })).status, 204);
  assert.equal((await request("/dashboard", { token: userToken })).body.counts.patients, 0);
});

test("SQLite account data persists when reopened through a new connection", () => {
  const reopened = new Database(process.env.DATABASE_PATH);
  const account = reopened.prepare("SELECT email FROM users WHERE email = ?").get("coordinator@example.test");
  assert.deepEqual(account, { email: "coordinator@example.test" });
  reopened.close();
});
