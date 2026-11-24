const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { loadData, saveData } = require("./db");
const webpush = require("web-push");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

const interactions = JSON.parse(fs.readFileSync(path.join(__dirname, "interactions.json"), "utf-8"));
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const PUSH_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const SNOOZES_FILE = path.join(DATA_DIR, "push-snoozes.json");
const KEYS_FILE = path.join(DATA_DIR, "push-keys.json");
const vapidKeys = fs.existsSync(KEYS_FILE)
  ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"))
  : webpush.generateVAPIDKeys();
if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, JSON.stringify(vapidKeys, null, 2));
webpush.setVapidDetails("mailto:admin@mediremind.local", vapidKeys.publicKey, vapidKeys.privateKey);
function readSubscriptions() { return fs.existsSync(PUSH_FILE) ? JSON.parse(fs.readFileSync(PUSH_FILE, "utf-8")) : []; }
function saveSubscriptions(subscriptions) { fs.writeFileSync(PUSH_FILE, JSON.stringify(subscriptions, null, 2)); }
function readSnoozes() { return fs.existsSync(SNOOZES_FILE) ? JSON.parse(fs.readFileSync(SNOOZES_FILE, "utf-8")) : []; }
function saveSnoozes(items) { fs.writeFileSync(SNOOZES_FILE, JSON.stringify(items, null, 2)); }
const sentReminders = new Set();

app.get("/api/push/public-key", (_req, res) => res.json({ publicKey: vapidKeys.publicKey }));
app.post("/api/push/subscribe", (req, res) => {
  const { patientId, subscription } = req.body;
  if (!Number.isInteger(Number(patientId)) || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: "A valid patient and browser subscription are required." });
  }
  const subscriptions = readSubscriptions().filter(s => s.subscription.endpoint !== subscription.endpoint);
  subscriptions.push({ patientId: Number(patientId), subscription });
  saveSubscriptions(subscriptions);
  res.json({ ok: true });
});
app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = req.body?.endpoint;
  saveSubscriptions(readSubscriptions().filter(s => s.subscription.endpoint !== endpoint));
  res.json({ ok: true });
});
app.post("/api/push/action", (req, res) => {
  const { action, patientId: rawPatientId, medicineId: rawMedicineId, doseTime, endpoint } = req.body || {};
  const patientId = Number(rawPatientId), medicineId = Number(rawMedicineId);
  if (!["taken", "later"].includes(action) || !Number.isInteger(patientId) || !Number.isInteger(medicineId) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(doseTime || "")) {
    return res.status(400).json({ error: "Invalid reminder action." });
  }
  const data = loadData();
  const med = data.medicines.find(m => m.id === medicineId && m.patientId === patientId && m.active);
  const subscription = readSubscriptions().find(s => s.patientId === patientId && s.subscription.endpoint === endpoint);
  if (!med || !subscription) return res.status(404).json({ error: "Medicine or notification subscription not found." });
  if (action === "taken") {
    data.doseLogs.push({ id: data.nextId.doseLogs++, medicineId, patientId, status: "taken", doseTime, loggedAt: new Date().toISOString() });
    saveData(data);
    saveSnoozes(readSnoozes().filter(s => !(s.patientId === patientId && s.medicineId === medicineId && s.doseTime === doseTime && s.endpoint === endpoint)));
  } else {
    const snoozes = readSnoozes().filter(s => !(s.patientId === patientId && s.medicineId === medicineId && s.doseTime === doseTime && s.endpoint === endpoint));
    snoozes.push({ patientId, medicineId, doseTime, endpoint, until: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    saveSnoozes(snoozes);
  }
  res.json({ ok: true });
});

// Push is sent by the server so the service worker can show reminders without an open page.
async function sendScheduledReminders() {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const data = loadData();
  let subscriptions = readSubscriptions();
  let snoozes = readSnoozes();
  const waiting = [];
  for (const item of snoozes) {
    if (new Date(item.until) > now) { waiting.push(item); continue; }
    const med = data.medicines.find(m => m.id === item.medicineId && m.patientId === item.patientId && m.active);
    const target = subscriptions.find(s => s.patientId === item.patientId && s.subscription.endpoint === item.endpoint);
    const recorded = data.doseLogs.some(log => log.patientId === item.patientId && log.medicineId === item.medicineId && log.doseTime === item.doseTime && log.status === "taken" && new Date(log.loggedAt).toDateString() === now.toDateString());
    if (med && target && !recorded) {
      try {
        await webpush.sendNotification(target.subscription, JSON.stringify({
          title: "Medi Remind · Reminder",
          body: `Reminder: take ${med.name}${med.dosage ? ` (${med.dosage})` : ""}, scheduled for ${item.doseTime}.`,
          url: "/patient.html", patientId: item.patientId, medicineId: med.id, doseTime: item.doseTime
        }));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) subscriptions = subscriptions.filter(s => s.subscription.endpoint !== target.subscription.endpoint);
        else console.error("Snoozed push reminder failed:", error.message);
      }
    }
  }
  saveSnoozes(waiting);
  saveSubscriptions(subscriptions);
  for (const med of data.medicines.filter(m => m.active && (m.times || []).includes(time))) {
    const key = `${day}:${med.patientId}:${med.id}:${time}`;
    if (sentReminders.has(key)) continue;
    sentReminders.add(key);
    const targets = subscriptions.filter(s => s.patientId === med.patientId);
    await Promise.all(targets.map(async target => {
      try {
        await webpush.sendNotification(target.subscription, JSON.stringify({
          title: "Medi Remind medicine alert",
          body: `Time to take ${med.name}${med.dosage ? ` (${med.dosage})` : ""}.`,
          url: "/patient.html", patientId: med.patientId, medicineId: med.id, doseTime: time
        }));
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) subscriptions = subscriptions.filter(s => s.subscription.endpoint !== target.subscription.endpoint);
        else console.error("Push reminder failed:", error.message);
      }
    }));
    saveSubscriptions(subscriptions);
  }
}

function findInteractions(newMedName, existingNames) {
  const warnings = [];
  for (const existing of existingNames) {
    for (const pair of interactions) {
      const match =
        (pair.a.toLowerCase() === newMedName.toLowerCase() && pair.b.toLowerCase() === existing.toLowerCase()) ||
        (pair.b.toLowerCase() === newMedName.toLowerCase() && pair.a.toLowerCase() === existing.toLowerCase());
      if (match) warnings.push({ with: existing, severity: pair.severity, note: pair.note });
    }
  }
  return warnings;
}

// ---- LOGIN ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const data = loadData();
  const user = data.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  res.json({
    id: user.id,
    role: user.role,
    name: user.name,
    location: user.location,
    linkedPatientId: user.linkedPatientId
  });
});

// ---- GET MEDICINES ----
app.get("/api/medicines", (req, res) => {
  const patientId = Number(req.query.patientId);
  const data = loadData();
  const meds = data.medicines.filter(m => m.patientId === patientId && m.active);
  res.json(meds);
});

app.get("/api/today", (req, res) => {
  const patientId = Number(req.query.patientId);
  const data = loadData();
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const meds = data.medicines.filter(m => m.patientId === patientId && m.active);
  const doses = meds.flatMap(m => (m.times || []).map(time => {
    const taken = data.doseLogs.some(log => {
      if (log.medicineId !== m.id || log.patientId !== patientId || log.status !== "taken" || log.doseTime !== time) return false;
      const logged = new Date(log.loggedAt);
      return `${logged.getFullYear()}-${logged.getMonth()}-${logged.getDate()}` === dateKey;
    });
    return { medicineId: m.id, medicineName: m.name, dosage: m.dosage || "", time,
      status: taken ? "taken" : time < clock ? "missed" : time === clock ? "due" : "upcoming" };
  }));
  res.json(doses.sort((a, b) => a.time.localeCompare(b.time)));
});

// ---- ADD MEDICINE ----
app.post("/api/medicines", (req, res) => {
  const patientId = Number(req.body.patientId);
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const { nameTelugu, dosage } = req.body;
  const times = Array.isArray(req.body.times) ? req.body.times : [];
  if (!Number.isInteger(patientId) || !name || !times.length || times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
    return res.status(400).json({ error: "Enter a medicine name and at least one valid dose time (HH:MM)." });
  }
  const data = loadData();
  if (!data.users.some(u => u.id === patientId && u.role === "patient")) {
    return res.status(404).json({ error: "Patient not found." });
  }

  const existingNames = data.medicines
    .filter(m => m.patientId === patientId && m.active)
    .map(m => m.name);

  const warnings = findInteractions(name, existingNames);

  const newMed = {
    id: data.nextId.medicines++,
    patientId,
    name,
    nameTelugu: nameTelugu || "",
    dosage: dosage || "",
    times: [...new Set(times)].sort(),
    active: true
  };
  data.medicines.push(newMed);
  saveData(data);

  res.json({ medicineId: newMed.id, warnings });
});

// ---- LOG A DOSE ----
app.post("/api/doselog", (req, res) => {
  const { medicineId, patientId, status, doseTime } = req.body;
  const data = loadData();

  data.doseLogs.push({
    id: data.nextId.doseLogs++,
    medicineId,
    patientId,
    status,
    doseTime: doseTime || null,
    loggedAt: new Date().toISOString()
  });
  saveData(data);

  res.json({ ok: true });
});

// ---- CAREGIVER DASHBOARD ----
app.get("/api/dashboard", (req, res) => {
  const patientId = Number(req.query.patientId);
  const data = loadData();
  const patient = data.users.find(u => u.id === patientId && u.role === "patient");

  const logs = data.doseLogs.filter(l => l.patientId === patientId);
  const takenCount = logs.filter(l => l.status === "taken").length;
  const adherence = logs.length === 0 ? null : Math.round((takenCount / logs.length) * 100);

  const recentLogs = [...logs]
    .sort((a, b) => new Date(b.loggedAt) - new Date(a.loggedAt))
    .slice(0, 10)
    .map(l => {
      const med = data.medicines.find(m => m.id === l.medicineId);
      return { ...l, medicineName: med ? med.name : "Unknown" };
    });

  const medNames = data.medicines
    .filter(m => m.patientId === patientId && m.active)
    .map(m => m.name);

  const activeWarnings = [];
  for (let i = 0; i < medNames.length; i++) {
    for (let j = i + 1; j < medNames.length; j++) {
      const found = findInteractions(medNames[i], [medNames[j]]);
      activeWarnings.push(...found.map(w => ({ ...w, medicine: medNames[i] })));
    }
  }

  res.json({ adherence, recentLogs, activeWarnings, patient: patient ? { name: patient.name, location: patient.location } : null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Medi Remind server listening on port ${PORT}`);
  sendScheduledReminders();
  setInterval(sendScheduledReminders, 15000);
});
