/** @OnlyCurrentDoc */
/**
 * Planning ING1 SI : devoirs proposés par la classe + mode délégué
 * Script à coller dans le Google Sheet : Extensions > Apps Script.
 *
 * Onglets :
 *  - Propositions : devoirs proposés (validés depuis le site ou à la main)
 *  - Modifs cours : annulations, visios, changements de salle, notes, cours ajoutés
 *  - Délégués     : noms des délégués et empreinte de leur code (jamais le code en clair)
 *
 * Menu « Planning » dans le Sheet : installer, ajouter / retirer un délégué, déconnecter tous les appareils.
 */

const SITE_URL = "https://hakimchaabna.github.io/edt-ing1-si/";

const ONGLET = "Propositions";
const COLONNES = ["ID", "Reçu le", "Date", "Heure", "Matière", "Type", "Parcours", "Détail", "Statut", "Remarque", "Traité par"];
const ONGLET_MODIFS = "Modifs cours";
const COLONNES_MODIFS = ["ID", "Date", "Créneau", "Matière", "Parcours", "Action", "Valeur", "Début", "Fin", "Titre", "Salle", "Par", "Le", "Active"];
const ONGLET_DELEGUES = "Délégués";
const COLONNES_DELEGUES = ["Nom", "Empreinte du code", "Actif"];

const TYPES = ["Interro", "À rendre", "À préparer"];
const PARCOURS = ["FISE", "FISA", "Les deux"];
const STATUTS = ["En attente", "Validé", "Refusé", "Doublon"];
const ACTIONS = ["cancel", "visio", "room", "note", "add"];
const ACTIONS_FR = { cancel: "Annulé", visio: "Visio", room: "Salle modifiée", note: "Note", add: "Cours ajouté" };

const MAX_DETAIL = 200;          // longueur maximale du détail
const MAX_EN_ATTENTE = 40;       // au-delà, les nouvelles propositions sont refusées
const MAIL_ACTIF = true;         // mail à chaque nouvelle proposition
const AUTRES_MAILS = "";         // adresses en plus, séparées par des virgules
const DUREE_SESSION_JOURS = 30;  // durée de connexion d'un téléphone en mode délégué
const ESSAIS_MAX = 8;            // essais de code ratés avant blocage
const BLOCAGE_MIN = 15;          // durée du blocage

const C = Object.fromEntries(COLONNES.map((n, i) => [n, i + 1]));
const M = Object.fromEntries(COLONNES_MODIFS.map((n, i) => [n, i + 1]));

/* ======================= Menu et installation ======================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Planning")
    .addItem("Ajouter un délégué", "ajouterDelegue")
    .addItem("Retirer un délégué", "retirerDelegue")
    .addItem("Déconnecter tous les appareils", "deconnecterTout")
    .addSeparator()
    .addItem("Installer / réparer", "installer")
    .addToUi();
}

function installer() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const liste = vals => SpreadsheetApp.newDataValidation().requireValueInList(vals, true).build();

  // Propositions
  const sh = feuille(ONGLET, COLONNES);
  const n = sh.getMaxRows() - 1;
  sh.getRange(2, C["Statut"], n, 1).setDataValidation(liste(STATUTS));
  sh.getRange(2, C["Type"], n, 1).setDataValidation(liste(TYPES));
  sh.getRange(2, C["Parcours"], n, 1).setDataValidation(liste(PARCOURS));
  sh.getRange("C:D").setNumberFormat("@");
  sh.setColumnWidth(C["Détail"], 320);
  const plage = sh.getRange(2, 1, n, COLONNES.length);
  const col = String.fromCharCode(64 + C["Statut"]);
  sh.setConditionalFormatRules([["Validé", "#E3F5E1"], ["Refusé", "#F3F3F3"], ["Doublon", "#F3F3F3"], ["En attente", "#FFF4DD"]]
    .map(([v, bg]) => SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=$${col}2="${v}"`)
      .setBackground(bg).setRanges([plage]).build()));

  // Modifs cours
  const mo = feuille(ONGLET_MODIFS, COLONNES_MODIFS);
  mo.getRange("B:B").setNumberFormat("@");
  mo.getRange("H:I").setNumberFormat("@");
  mo.getRange(2, M["Active"], mo.getMaxRows() - 1, 1).insertCheckboxes();

  // Délégués
  const de = feuille(ONGLET_DELEGUES, COLONNES_DELEGUES);
  de.getRange(2, 3, de.getMaxRows() - 1, 1).insertCheckboxes();

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty("sel")) props.setProperty("sel", Utilities.getUuid());
  if (MAIL_ACTIF) MailApp.getRemainingDailyQuota(); // demande l'autorisation d'envoyer des mails
  SpreadsheetApp.getUi().alert("Installation terminée. Ajoute maintenant ton code délégué : menu Planning > Ajouter un délégué.");
}

function feuille(nom, colonnes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(nom) || ss.insertSheet(nom);
  sh.getRange(1, 1, 1, colonnes.length).setValues([colonnes]).setFontWeight("bold");
  sh.setFrozenRows(1);
  return sh;
}

function ajouterDelegue() {
  const ui = SpreadsheetApp.getUi();
  const nom = ui.prompt("Nom du délégué", "Ex. Hakim", ui.ButtonSet.OK_CANCEL);
  if (nom.getSelectedButton() !== ui.Button.OK || !nom.getResponseText().trim()) return;
  const code = ui.prompt("Code délégué",
    "Au moins 10 caractères. Une phrase est idéale (ex. cafe-rer-a-sept-heures). Il ne sera plus jamais affiché.",
    ui.ButtonSet.OK_CANCEL);
  if (code.getSelectedButton() !== ui.Button.OK) return;
  const c = code.getResponseText().trim();
  if (c.length < 10) return ui.alert("Code trop court : 10 caractères minimum.");
  if (deleguePourCode(c)) return ui.alert("Ce code est déjà utilisé par un autre délégué.");
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET_DELEGUES)
    .appendRow([nom.getResponseText().trim(), empreinte(c), true]);
  ui.alert(`C'est fait. ${nom.getResponseText().trim()} peut se connecter sur le site avec ce code (lien « Mode délégué » en bas de page).`);
}

function retirerDelegue() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt("Retirer un délégué", "Nom exact du délégué à retirer :", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET_DELEGUES);
  const v = sh.getDataRange().getValues();
  let trouve = false;
  v.forEach((l, i) => { if (i > 0 && String(l[0]).trim() === r.getResponseText().trim()) { sh.getRange(i + 1, 3).setValue(false); trouve = true; } });
  ui.alert(trouve ? "Délégué désactivé. Ses téléphones sont déconnectés." : "Aucun délégué avec ce nom.");
}

function deconnecterTout() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).filter(k => k.startsWith("s_")).forEach(k => props.deleteProperty(k));
  SpreadsheetApp.getUi().alert("Tous les appareils sont déconnectés du mode délégué.");
}

/* ======================= Lecture par le site ======================= */

function doGet() {
  const cache = CacheService.getScriptCache();
  const enCache = cache.get("liste");
  if (enCache) return json(JSON.parse(enCache));

  const hier = jour(-1);
  const items = lignes()
    .filter(r => (r.statut === "Validé" || r.statut === "En attente") && r.date >= hier)
    .map(r => ({
      id: r.id, date: r.date, time: r.heure || null, code: r.matiere, type: r.type,
      tracks: parcoursListe(r.parcours),
      status: r.statut === "Validé" ? "ok" : "pending",
      detail: r.statut === "Validé" ? r.detail : null, // jamais de texte libre avant validation
    }));
  const changes = modifs()
    .filter(m => m.active && m.date >= hier)
    .map(m => ({
      id: m.id, date: m.date, slot: m.creneau || null, code: m.matiere, action: m.action,
      value: m.valeur, start: m.debut, end: m.fin, title: m.titre, room: m.salle,
      tracks: parcoursListe(m.parcours),
    }));
  const data = { updated: new Date().toISOString(), items, changes };
  cache.put("liste", JSON.stringify(data), 20);
  return json(data);
}

/* ======================= Écriture ======================= */

function doPost(e) {
  try {
    const p = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (!p.action) return proposer(p);
    if (p.action === "login") return connexion(p);

    const qui = session(p.token);
    if (!qui) return json({ ok: false, error: "session" });
    if (p.action === "pending") return json({ ok: true, items: enAttente() });
    if (p.action === "review") return avecVerrou(() => examiner(p, qui));
    if (p.action === "addhw") return avecVerrou(() => ajouterDevoir(p, qui));
    if (p.action === "change") return avecVerrou(() => modifierCours(p, qui));
    return json({ ok: false, error: "action" });
  } catch (err) {
    return json({ ok: false, error: "serveur" });
  }
}

/* ---- proposition anonyme ---- */
function proposer(p) {
  if (p.website) return json({ ok: true }); // champ piège rempli = robot
  const d = nettoyerDevoir(p);
  if (d.erreur) return json({ ok: false, error: d.erreur });
  return avecVerrou(() => {
    const existantes = lignes();
    if (existantes.filter(r => r.statut === "En attente").length >= MAX_EN_ATTENTE) return json({ ok: false, error: "plein" });
    const doublon = existantes.find(r => (r.statut === "En attente" || r.statut === "Validé") && memeDevoir(r, d));
    const id = Utilities.getUuid().slice(0, 8);
    const remarque = doublon ? `Doublon possible de ${doublon.id}` : "";
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET).appendRow(
      [id, Utilities.formatDate(new Date(), "Europe/Paris", "dd/MM/yyyy HH:mm"), d.date, d.heure, d.matiere, d.type, d.parcours, d.detail, "En attente", remarque, ""]);
    viderCache();
    if (MAIL_ACTIF) prevenir({ id, ...d, remarque });
    return json({ ok: true, id });
  });
}

/* ---- connexion délégué ---- */
function connexion(p) {
  const cache = CacheService.getScriptCache();
  const echecs = Number(cache.get("echecs") || 0);
  if (echecs >= ESSAIS_MAX) return json({ ok: false, error: "bloque" });
  const qui = deleguePourCode(String(p.code || "").trim());
  if (!qui) {
    cache.put("echecs", String(echecs + 1), BLOCAGE_MIN * 60);
    Utilities.sleep(800); // ralentit les essais en série
    return json({ ok: false, error: "code" });
  }
  const jeton = Utilities.getUuid() + Utilities.getUuid();
  const exp = Date.now() + DUREE_SESSION_JOURS * 864e5;
  PropertiesService.getScriptProperties().setProperty("s_" + empreinte(jeton), JSON.stringify({ nom: qui, exp }));
  nettoyerSessions();
  return json({ ok: true, token: jeton, name: qui });
}

function session(jeton) {
  if (!jeton) return null;
  const props = PropertiesService.getScriptProperties();
  const cle = "s_" + empreinte(String(jeton));
  const s = props.getProperty(cle);
  if (!s) return null;
  const { nom, exp } = JSON.parse(s);
  if (Date.now() > exp || !delegues().some(d => d.nom === nom && d.actif)) { props.deleteProperty(cle); return null; }
  return nom;
}

function nettoyerSessions() {
  const props = PropertiesService.getScriptProperties();
  Object.entries(props.getProperties()).forEach(([k, v]) => {
    if (k.startsWith("s_")) { try { if (Date.now() > JSON.parse(v).exp) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); } }
  });
}

/* ---- validation des propositions ---- */
function enAttente() {
  return lignes().filter(r => r.statut === "En attente").map(r => ({
    id: r.id, date: r.date, time: r.heure || null, code: r.matiere, type: r.type,
    track: r.parcours, detail: r.detail, remark: r.remarque,
  }));
}

function examiner(p, qui) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET);
  const toutes = lignes();
  const r = toutes.find(x => x.id === p.id);
  if (!r) return json({ ok: false, error: "introuvable" });
  if (p.decision === "refuse") {
    sh.getRange(r.ligne, C["Statut"]).setValue("Refusé");
    sh.getRange(r.ligne, C["Traité par"]).setValue(trace(qui));
  } else if (p.decision === "ok") {
    let d = r;
    if (p.fields) {
      d = nettoyerDevoir(p.fields);
      if (d.erreur) return json({ ok: false, error: d.erreur });
      sh.getRange(r.ligne, C["Date"], 1, 6).setValues([[d.date, d.heure, d.matiere, d.type, d.parcours, d.detail]]);
      d = { ...r, ...d };
    }
    sh.getRange(r.ligne, C["Statut"]).setValue("Validé");
    sh.getRange(r.ligne, C["Traité par"]).setValue(trace(qui));
    marquerDoublons(sh, toutes, { ...d, ligne: r.ligne, id: r.id });
  } else return json({ ok: false, error: "decision" });
  viderCache();
  return json({ ok: true });
}

/* ---- devoir ajouté directement par un délégué (publié sans validation) ---- */
function ajouterDevoir(p, qui) {
  const d = nettoyerDevoir(p);
  if (d.erreur) return json({ ok: false, error: d.erreur });
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET);
  const id = Utilities.getUuid().slice(0, 8);
  sh.appendRow([id, Utilities.formatDate(new Date(), "Europe/Paris", "dd/MM/yyyy HH:mm"), d.date, d.heure, d.matiere, d.type,
    d.parcours, d.detail, "Validé", "Ajouté par un délégué", trace(qui)]);
  marquerDoublons(sh, lignes(), { ...d, ligne: sh.getLastRow(), id });
  viderCache();
  return json({ ok: true, id });
}

/* ---- modifications de cours ---- */
function modifierCours(p, qui) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET_MODIFS);
  if (p.op === "remove") {
    const m = modifs().find(x => x.id === p.id && x.active);
    if (!m) return json({ ok: false, error: "introuvable" });
    sh.getRange(m.ligne, M["Active"]).setValue(false);
    sh.getRange(m.ligne, M["Par"]).setValue(`${m.par} · retiré par ${qui}`);
    viderCache();
    return json({ ok: true });
  }
  const c = p.change || {};
  const date = String(c.date || ""), matiere = String(c.code || "").trim().toUpperCase();
  const action = String(c.action || ""), parcours = String(c.track || "Les deux");
  const creneau = c.slot === "matin" || c.slot === "aprem" ? c.slot : "";
  const court = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  const valeur = court(c.value, 120), titre = court(c.title, 80), salle = court(c.room, 40);
  const heure = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || "")) ? String(h) : "";
  const debut = heure(c.start), fin = heure(c.end);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < jour(-1) || date > jour(200)) return json({ ok: false, error: "date" });
  if (!/^[A-Z0-9]{1,12}$/.test(matiere)) return json({ ok: false, error: "matiere" });
  if (!ACTIONS.includes(action)) return json({ ok: false, error: "action" });
  if (!PARCOURS.includes(parcours)) return json({ ok: false, error: "parcours" });
  if ((action === "room" || action === "note") && !valeur) return json({ ok: false, error: "valeur" });
  if (action === "add" && (!debut || !fin || fin <= debut)) return json({ ok: false, error: "heure" });

  // une seule modif active du même type sur le même cours : la nouvelle remplace l'ancienne
  if (action !== "add") {
    modifs().filter(m => m.active && m.date === date && m.matiere === matiere && m.action === action && m.creneau === creneau)
      .forEach(m => sh.getRange(m.ligne, M["Active"]).setValue(false));
  }
  const id = Utilities.getUuid().slice(0, 8);
  sh.appendRow([id, date, creneau, matiere, parcours, action, valeur, debut, fin, titre, salle, qui,
    Utilities.formatDate(new Date(), "Europe/Paris", "dd/MM/yyyy HH:mm"), true]);
  viderCache();
  return json({ ok: true, id });
}

/* ======================= Modifications à la main dans le Sheet ======================= */

// Déclencheur simple : s'exécute quand quelqu'un modifie le Sheet à la main.
function onEdit(e) {
  const sh = e.range.getSheet();
  viderCache(); // toute modif est visible tout de suite sur le site
  if (sh.getName() !== ONGLET || e.range.getRow() < 2) return;
  if (e.range.getColumn() !== C["Statut"] || e.value !== "Validé") return;
  const toutes = lignes();
  const validee = toutes.find(r => r.ligne === e.range.getRow());
  if (validee) marquerDoublons(sh, toutes, validee);
}

/* ======================= Outils ======================= */

function nettoyerDevoir(p) {
  const d = {
    date: String(p.date || ""), heure: String(p.time || ""),
    matiere: String(p.code || "").trim().toUpperCase(), type: String(p.type || ""),
    parcours: String(p.track || ""), detail: String(p.detail || "").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL),
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date < jour(-1) || d.date > jour(200)) return { erreur: "date" };
  if (d.heure && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.heure)) return { erreur: "heure" };
  if (!/^[A-Z0-9]{1,12}$/.test(d.matiere)) return { erreur: "matiere" };
  if (!TYPES.includes(d.type)) return { erreur: "type" };
  if (!PARCOURS.includes(d.parcours)) return { erreur: "parcours" };
  return d;
}

function marquerDoublons(sh, toutes, validee) {
  toutes.filter(r => r.ligne !== validee.ligne && r.statut === "En attente" && memeDevoir(r, validee)).forEach(r => {
    sh.getRange(r.ligne, C["Statut"]).setValue("Doublon");
    sh.getRange(r.ligne, C["Remarque"]).setValue(`Doublon de ${validee.id}`);
  });
}

function lignes() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLONNES.length).getDisplayValues().map((v, i) => ({
    ligne: i + 2, id: v[C["ID"] - 1], date: normaliserDate(v[C["Date"] - 1]), heure: v[C["Heure"] - 1],
    matiere: String(v[C["Matière"] - 1]).trim().toUpperCase(), type: v[C["Type"] - 1],
    parcours: v[C["Parcours"] - 1] || "Les deux", detail: v[C["Détail"] - 1],
    statut: v[C["Statut"] - 1], remarque: v[C["Remarque"] - 1],
  })).filter(r => r.id || r.date);
}

function modifs() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET_MODIFS);
  if (!sh) return [];
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLONNES_MODIFS.length).getValues().map((v, i) => {
    const t = k => String(v[M[k] - 1] instanceof Date ? Utilities.formatDate(v[M[k] - 1], "Europe/Paris", k === "Date" ? "yyyy-MM-dd" : "HH:mm") : v[M[k] - 1]).trim();
    return {
      ligne: i + 2, id: t("ID"), date: normaliserDate(t("Date")), creneau: t("Créneau"),
      matiere: t("Matière").toUpperCase(), parcours: t("Parcours") || "Les deux", action: t("Action"),
      valeur: t("Valeur"), debut: t("Début"), fin: t("Fin"), titre: t("Titre"), salle: t("Salle"),
      par: t("Par"), active: v[M["Active"] - 1] === true,
    };
  }).filter(m => m.id && ACTIONS.includes(m.action));
}

function delegues() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ONGLET_DELEGUES);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .map(v => ({ nom: String(v[0]).trim(), empreinte: String(v[1]), actif: v[2] === true }))
    .filter(d => d.nom && d.empreinte);
}

function deleguePourCode(code) {
  if (!code) return null;
  const e = empreinte(code);
  const d = delegues().find(x => x.actif && x.empreinte === e);
  return d ? d.nom : null;
}

// empreinte SHA-256 salée : on ne garde jamais un code ou un jeton en clair
function empreinte(s) {
  const sel = PropertiesService.getScriptProperties().getProperty("sel") || "";
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sel + "|" + s)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

function avecVerrou(f) {
  const v = LockService.getScriptLock();
  v.waitLock(10000);
  try { return f(); } finally { v.releaseLock(); }
}

function memeDevoir(a, b) {
  const pa = a.parcours, pb = b.parcours;
  return a.date === b.date && a.matiere === b.matiere && a.type === b.type && (pa === "Les deux" || pb === "Les deux" || pa === pb);
}

function normaliserDate(s) {
  s = String(s).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : s;
}

const jour = decalage => Utilities.formatDate(new Date(Date.now() + decalage * 864e5), "Europe/Paris", "yyyy-MM-dd");
const parcoursListe = p => p === "Les deux" ? ["FISE", "FISA"] : [p];
const trace = qui => `${qui} · ${Utilities.formatDate(new Date(), "Europe/Paris", "dd/MM HH:mm")}`;
const viderCache = () => CacheService.getScriptCache().remove("liste");

function prevenir(r) {
  const corps = [
    `Nouvelle proposition sur le planning :`, ``,
    `${r.type} · ${r.matiere} · ${r.date}${r.heure ? " à " + r.heure : ""} · ${r.parcours}`,
    r.detail ? `Détail : ${r.detail}` : `Pas de détail`,
    r.remarque ? `⚠️ ${r.remarque}` : ``, ``,
    `Valider depuis le site (mode délégué) : ${SITE_URL}`,
    `Ou dans le Sheet : ${SpreadsheetApp.getActiveSpreadsheet().getUrl()}`,
  ].join("\n");
  const dest = [Session.getEffectiveUser().getEmail(), AUTRES_MAILS].filter(Boolean).join(",");
  MailApp.sendEmail(dest, `Planning : ${r.type} ${r.matiere} proposé`, corps);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
