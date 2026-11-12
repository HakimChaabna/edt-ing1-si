/**
 * Devoirs et interros de la classe ING1 SI
 * Script à coller dans le Google Sheet : Extensions > Apps Script.
 *
 * - doGet  : renvoie au site les devoirs à afficher (validés + en attente)
 * - doPost : reçoit une proposition depuis le formulaire du site
 * - onEdit : quand un délégué valide une ligne, ses doublons passent en « Doublon »
 *
 * Avant la première utilisation, lance une fois la fonction « installer » (menu Exécuter).
 */

const ONGLET = "Propositions";
const COLONNES = ["ID", "Reçu le", "Date", "Heure", "Matière", "Type", "Parcours", "Détail", "Statut", "Remarque"];
const TYPES = ["Interro", "À rendre", "À préparer"];
const PARCOURS = ["FISE", "FISA", "Les deux"];
const STATUTS = ["En attente", "Validé", "Refusé", "Doublon"];

const MAX_DETAIL = 200;      // longueur maximale du détail
const MAX_EN_ATTENTE = 40;   // au-delà, les nouvelles propositions sont refusées
const MAIL_ACTIF = true;     // mail aux délégués à chaque nouvelle proposition
const AUTRES_MAILS = "";      // adresses en plus, séparées par des virgules (ex. l'autre délégué)

// Colonnes (numérotées à partir de 1)
const C = Object.fromEntries(COLONNES.map((n, i) => [n, i + 1]));

/* ---------- Installation (à lancer une seule fois) ---------- */

function installer() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ONGLET);
  if (!sh) sh = ss.insertSheet(ONGLET);
  sh.getRange(1, 1, 1, COLONNES.length).setValues([COLONNES]).setFontWeight("bold");
  sh.setFrozenRows(1);
  const regle = SpreadsheetApp.newDataValidation().requireValueInList(STATUTS, true).build();
  sh.getRange(2, C["Statut"], sh.getMaxRows() - 1, 1).setDataValidation(regle);
  const regleType = SpreadsheetApp.newDataValidation().requireValueInList(TYPES, true).build();
  sh.getRange(2, C["Type"], sh.getMaxRows() - 1, 1).setDataValidation(regleType);
  const regleParcours = SpreadsheetApp.newDataValidation().requireValueInList(PARCOURS, true).build();
  sh.getRange(2, C["Parcours"], sh.getMaxRows() - 1, 1).setDataValidation(regleParcours);
  sh.getRange("C:C").setNumberFormat("@"); // dates gardées en texte AAAA-MM-JJ
  sh.getRange("D:D").setNumberFormat("@"); // heures gardées en texte HH:MM
  sh.setColumnWidth(C["Détail"], 320);
  // couleurs des statuts
  const plage = sh.getRange(2, 1, sh.getMaxRows() - 1, COLONNES.length);
  const col = String.fromCharCode(64 + C["Statut"]);
  const regles = [
    ["Validé", "#E3F5E1"], ["Refusé", "#F3F3F3"], ["Doublon", "#F3F3F3"], ["En attente", "#FFF4DD"],
  ].map(([v, bg]) => SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=$${col}2="${v}"`).setBackground(bg).setRanges([plage]).build());
  sh.setConditionalFormatRules(regles);
  // demande l'autorisation d'envoyer des mails dès l'installation
  if (MAIL_ACTIF) MailApp.getRemainingDailyQuota();
  SpreadsheetApp.getUi().alert("Installation terminée. Tu peux maintenant déployer le script en application web.");
}

/* ---------- Lecture par le site ---------- */

function doGet() {
  const cache = CacheService.getScriptCache();
  const enCache = cache.get("liste");
  if (enCache) return json(JSON.parse(enCache));

  const hier = Utilities.formatDate(new Date(Date.now() - 864e5), "Europe/Paris", "yyyy-MM-dd");
  const items = lignes()
    .filter(r => (r.statut === "Validé" || r.statut === "En attente") && r.date >= hier)
    .map(r => ({
      id: r.id,
      date: r.date,
      time: r.heure || null,
      code: r.matiere,
      type: r.type,
      tracks: r.parcours === "Les deux" ? ["FISE", "FISA"] : [r.parcours],
      status: r.statut === "Validé" ? "ok" : "pending",
      // le texte libre n'est jamais envoyé tant que ce n'est pas validé (anti-troll)
      detail: r.statut === "Validé" ? r.detail : null,
    }));
  const data = { updated: new Date().toISOString(), items };
  cache.put("liste", JSON.stringify(data), 20); // 20 s de cache pour encaisser les visites
  return json(data);
}

/* ---------- Réception d'une proposition ---------- */

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents || "{}");
    if (p.website) return json({ ok: true }); // champ piège rempli = robot, on ignore en silence

    const date = String(p.date || "");
    const heure = String(p.time || "");
    const matiere = String(p.code || "").trim().toUpperCase();
    const type = String(p.type || "");
    const parcours = String(p.track || "");
    const detail = String(p.detail || "").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL);

    const auj = new Date();
    const min = Utilities.formatDate(new Date(auj.getTime() - 864e5), "Europe/Paris", "yyyy-MM-dd");
    const max = Utilities.formatDate(new Date(auj.getTime() + 200 * 864e5), "Europe/Paris", "yyyy-MM-dd");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < min || date > max) return json({ ok: false, error: "date" });
    if (heure && !/^([01]\d|2[0-3]):[0-5]\d$/.test(heure)) return json({ ok: false, error: "heure" });
    if (!/^[A-Z0-9]{1,12}$/.test(matiere)) return json({ ok: false, error: "matiere" });
    if (!TYPES.includes(type)) return json({ ok: false, error: "type" });
    if (!PARCOURS.includes(parcours)) return json({ ok: false, error: "parcours" });

    const verrou = LockService.getScriptLock();
    verrou.waitLock(10000);
    try {
      const existantes = lignes();
      if (existantes.filter(r => r.statut === "En attente").length >= MAX_EN_ATTENTE) {
        return json({ ok: false, error: "plein" });
      }
      const doublon = existantes.find(r =>
        (r.statut === "En attente" || r.statut === "Validé") && memeDevoir(r, { date, matiere, type, parcours }));
      const id = Utilities.getUuid().slice(0, 8);
      const recu = Utilities.formatDate(auj, "Europe/Paris", "dd/MM/yyyy HH:mm");
      const remarque = doublon ? `Doublon possible de ${doublon.id}` : "";
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET)
        .appendRow([id, recu, date, heure, matiere, type, parcours, detail, "En attente", remarque]);
      CacheService.getScriptCache().remove("liste");
      if (MAIL_ACTIF) prevenir({ id, date, heure, matiere, type, parcours, detail, remarque });
      return json({ ok: true, id });
    } finally {
      verrou.releaseLock();
    }
  } catch (err) {
    return json({ ok: false, error: "serveur" });
  }
}

/* ---------- Validation par un délégué ---------- */

// Déclencheur simple : s'exécute tout seul quand on modifie le Sheet.
function onEdit(e) {
  const sh = e.range.getSheet();
  if (sh.getName() !== ONGLET || e.range.getRow() < 2) return;
  CacheService.getScriptCache().remove("liste"); // toute modif est visible tout de suite sur le site
  if (e.range.getColumn() !== C["Statut"] || e.value !== "Validé") return;

  const toutes = lignes();
  const validee = toutes.find(r => r.ligne === e.range.getRow());
  if (!validee) return;
  toutes
    .filter(r => r.ligne !== validee.ligne && r.statut === "En attente" && memeDevoir(r, validee))
    .forEach(r => {
      sh.getRange(r.ligne, C["Statut"]).setValue("Doublon");
      sh.getRange(r.ligne, C["Remarque"]).setValue(`Doublon de ${validee.id}`);
    });
}

/* ---------- Outils ---------- */

function lignes() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLONNES.length).getDisplayValues().map((v, i) => ({
    ligne: i + 2,
    id: v[C["ID"] - 1],
    date: normaliserDate(v[C["Date"] - 1]),
    heure: v[C["Heure"] - 1],
    matiere: String(v[C["Matière"] - 1]).trim().toUpperCase(),
    type: v[C["Type"] - 1],
    parcours: v[C["Parcours"] - 1] || "Les deux",
    detail: v[C["Détail"] - 1],
    statut: v[C["Statut"] - 1],
  })).filter(r => r.id || r.date);
}

// accepte AAAA-MM-JJ ou JJ/MM/AAAA (si un délégué corrige la date à la main)
function normaliserDate(s) {
  s = String(s).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return s;
}

function memeDevoir(a, b) {
  const pa = a.parcours, pb = b.parcours;
  const parcoursCommun = pa === "Les deux" || pb === "Les deux" || pa === pb;
  return a.date === b.date && a.matiere === b.matiere && a.type === b.type && parcoursCommun;
}

function prevenir(r) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const corps = [
    `Nouvelle proposition sur le planning :`,
    ``,
    `${r.type} · ${r.matiere} · ${r.date}${r.heure ? " à " + r.heure : ""} · ${r.parcours}`,
    r.detail ? `Détail : ${r.detail}` : `Pas de détail`,
    r.remarque ? `⚠️ ${r.remarque}` : ``,
    ``,
    `Valider, modifier ou refuser : ${ss.getUrl()}`,
  ].join("\n");
  const dest = [Session.getEffectiveUser().getEmail(), AUTRES_MAILS].filter(Boolean).join(",");
  MailApp.sendEmail(dest, `Planning : ${r.type} ${r.matiere} proposé`, corps);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
