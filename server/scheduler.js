import { sendTextbeeSms, smsConfigured, medicineSms } from "./textbee.js";
export function startReminderScheduler({ db, webpush, pushConfigured, localDate, localTime }) {
  markMissedReminders({ db, localDate, localTime });
  const timer = setInterval(() => {
    void processDueReminders({ db, webpush, pushConfigured, localDate, localTime })
      .catch((error) => console.error("Reminder scheduler failed:", error));
    markMissedReminders({ db, localDate, localTime });
  }, 15_000);
  timer.unref();
}

export async function processDueReminders({ db, webpush, pushConfigured, localDate, localTime, now = new Date() }) {
  const date = localDate(now);
  const time = localTime(now);
  const day = now.getDay();
  const due = db.prepare(`SELECT r.id AS reminderId, r.user_id AS userId, r.times, r.days,
    pr.medicine_name AS medicineName, pr.dosage, p.name AS patientName, p.contact
    FROM reminders r JOIN prescriptions pr ON pr.id = r.prescription_id AND pr.user_id = r.user_id
    JOIN patients p ON p.id = pr.patient_id AND p.user_id = pr.user_id
    WHERE r.is_active = 1 AND r.start_date <= ? AND r.end_date >= ?
      AND pr.start_date <= ? AND pr.end_date >= ?`).all(date, date, date, date);
  for (const reminder of due) {
    if (!JSON.parse(reminder.days).includes(day) || !JSON.parse(reminder.times).includes(time)) continue;
    const scheduledFor = `${date}T${time}:00`;
    const message = `${reminder.patientName}: ${reminder.medicineName} — ${reminder.dosage} (${time})`;
    const result = db.prepare(`INSERT OR IGNORE INTO notification_logs (user_id, reminder_id, scheduled_for, status, message)
      VALUES (?, ?, ?, 'sent', ?)`).run(reminder.userId, reminder.reminderId, scheduledFor, message);
    if (result.changes) {
      if (smsConfigured()) {
        try {
          await sendTextbeeSms({ phone: reminder.contact, message: medicineSms(reminder, time) });
        } catch (error) {
          console.error("Reminder SMS failed:", error.message);
          db.prepare("UPDATE notification_logs SET status = 'failed' WHERE user_id = ? AND reminder_id = ? AND scheduled_for = ?")
            .run(reminder.userId, reminder.reminderId, scheduledFor);
        }
      }
      if (pushConfigured) await sendPushToUser({ db, webpush, userId: reminder.userId, reminder, time, date, scheduledFor });
    }
  }
}

export function markMissedReminders({ db, localDate, localTime, now = new Date() }) {
  const date = localDate(now);
  const time = localTime(now);
  const day = now.getDay();
  const rows = db.prepare(`SELECT r.id AS reminderId, r.user_id AS userId, r.times, r.days,
    pr.medicine_name AS medicineName, pr.dosage, p.name AS patientName, p.contact
    FROM reminders r JOIN prescriptions pr ON pr.id = r.prescription_id AND pr.user_id = r.user_id
    JOIN patients p ON p.id = pr.patient_id AND p.user_id = pr.user_id
    WHERE r.is_active = 1 AND r.start_date <= ? AND r.end_date >= ?
      AND pr.start_date <= ? AND pr.end_date >= ?`).all(date, date, date, date);
  for (const reminder of rows) {
    if (!JSON.parse(reminder.days).includes(day)) continue;
    for (const scheduledTime of JSON.parse(reminder.times).filter((value) => value < time)) {
      const scheduledFor = `${date}T${scheduledTime}:00`;
      const message = `${reminder.patientName}: ${reminder.medicineName} — ${reminder.dosage} (${scheduledTime})`;
      db.prepare(`INSERT OR IGNORE INTO notification_logs (user_id, reminder_id, scheduled_for, status, message)
        VALUES (?, ?, ?, 'missed', ?)`).run(reminder.userId, reminder.reminderId, scheduledFor, message);
    }
  }
}

async function sendPushToUser({ db, webpush, userId, reminder, time, date, scheduledFor }) {
  const subscriptions = db.prepare("SELECT id, endpoint, subscription FROM push_subscriptions WHERE user_id = ?").all(userId);
  const payload = JSON.stringify({
    title: "Medicine reminder",
    body: `${reminder.patientName}: ${reminder.medicineName} — ${reminder.dosage} (${time})`,
    tag: `medicine-${reminder.reminderId}-${date}-${time}`,
    url: "/"
  });
  for (const item of subscriptions) {
    try {
      await webpush.sendNotification(JSON.parse(item.subscription), payload);
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(item.id);
      } else {
        console.error("Could not deliver a push notification:", error);
        db.prepare(`UPDATE notification_logs SET status = 'failed' WHERE user_id = ? AND reminder_id = ?
          AND scheduled_for = ?`).run(userId, reminder.reminderId, scheduledFor);
      }
    }
  }
}
