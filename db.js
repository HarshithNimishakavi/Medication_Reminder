const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "data.json");

function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], medicines: [], doseLogs: [], nextId: { users: 1, medicines: 1, doseLogs: 1 } };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---- Seed demo users only if empty ----
let data = loadData();

if (data.users.length === 0) {
  // ============================================
  // 👉 PATIENT INFO — edit these 4 values
  // ============================================
  const patient = {
    id: data.nextId.users++,
    username: "ammamma",           // login username
    password: "1234",              // password
    role: "patient",
    name: "Seetamahalakshmi",    // her real name
    location: "Tadepalligudem",
    linkedPatientId: null
  };
  data.users.push(patient);

  // ============================================
  // 👉 CAREGIVER INFO — edit these 4 values
  // ============================================
  const caregiver = {
    id: data.nextId.users++,
    username: "uncle",             // login username
    password: "1234",              // password
    role: "caregiver",
    name: "Kiran",          // his real name
    location: "Kakinada",
    linkedPatientId: patient.id    // links him to her — don't change this
  };
  data.users.push(caregiver);

  // ============================================
  // 👉 MEDICINES — edit / add more as needed
  // ============================================
  data.medicines.push({
    id: data.nextId.medicines++,
    patientId: patient.id,
    name: "Metformin",
    nameTelugu: "మెట్‌ఫార్మిన్",
    dosage: "500mg",
    times: ["08:00", "20:00"],
    active: true
  });
  data.medicines.push({
    id: data.nextId.medicines++,
    patientId: patient.id,
    name: "Atorvastatin",
    nameTelugu: "అటోర్వాస్టాటిన్",
    dosage: "10mg",
    times: ["21:00"],
    active: true
  });

  saveData(data);
  console.log("Seeded: ammamma/1234 (patient), uncle/1234 (caregiver)");
}

module.exports = { loadData, saveData };
