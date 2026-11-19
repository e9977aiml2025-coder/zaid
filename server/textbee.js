export function smsConfigured() { return process.env.SMS_ENABLED === "true" && Boolean(process.env.TEXTBEE_API_KEY); }
export function normalizeIndianPhone(value) {
  const raw = String(value || "").replace(/[\s()-]/g, "");
  const normalized = /^[6-9]\d{9}$/.test(raw) ? `+91${raw}` : /^91[6-9]\d{9}$/.test(raw) ? `+${raw}` : raw;
  if (!/^\+91[6-9]\d{9}$/.test(normalized)) throw new Error("Enter a valid Indian mobile number (+91XXXXXXXXXX).");
  return normalized;
}
export async function sendTextbeeSms({ phone, message }) {
  if (!smsConfigured()) throw new Error("SMS is not configured. Set SMS_ENABLED=true and TEXTBEE_API_KEY in .env.");
  const recipients = [normalizeIndianPhone(phone)];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const payload = { recipients, message };
    if (process.env.TEXTBEE_DEVICE_ID) payload.deviceId = process.env.TEXTBEE_DEVICE_ID;
    const response = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": process.env.TEXTBEE_API_KEY },
      body: JSON.stringify(payload), signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.data?.success === false) throw new Error(`textbee ${response.status}: ${String(result.error || result.message || "Request failed").slice(0, 180)}`);
    return { queued: true, batchId: result.data?.smsBatchId || null };
  } finally { clearTimeout(timeout); }
}
export function medicineSms(reminder, time) {
  return `MediSense reminder for ${reminder.patientName}: Take ${reminder.medicineName} (${reminder.dosage}) at ${time}, as prescribed by your doctor.`;
}
