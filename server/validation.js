export function text(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${field} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

export function date(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid date (YYYY-MM-DD).`);
  }
  return value;
}

export function optionalText(value, field, max = 2000) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return value.trim();
}
