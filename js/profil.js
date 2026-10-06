"use strict";

// =====================================================================
// profil.js – page « Mon profil »
//
// Chaque joueur modifie ici sa propre ligne de la table players : pseudo,
// rôle, Riot ID principal et comptes secondaires (smurfs). La base ne
// laisse modifier que ces colonnes, et seulement sur sa propre ligne
// (voir sql/11_profil_smurfs.sql) : le statut et le droit d'admin
// restent réservés au dashboard Supabase.
//
// Les Riot ID servent au companion (il garde les games où au moins 4
// comptes de la team jouent ensemble) et à la page Statistiques.
// =====================================================================

const MAX_SMURFS = 5;
const STATUS_NAMES = { titulaire: "Titulaire", remplacant: "Remplaçant", coach: "Coach" };

// "Queen Isa#EUW" → "queenisa#euw" : majuscules et espaces ne comptent pas
const normId = (riotId) => (riotId || "").replace(/\s+/g, "").toLowerCase();

// Un Riot ID complet : un pseudo, un "#", puis un tag de 2 à 5 caractères
const isRiotId = (value) => /^[^#]{3,16}#[^#\s]{2,5}$/.test(value.trim());

function profileError(message) {
  const box = $("#profile-error");
  box.textContent = message;
  box.hidden = !message;
}

// Une ligne de smurf : un champ et son bouton pour le retirer
function smurfRow(value = "") {
  const input = el("input", {
    type: "text", maxlength: "40", autocomplete: "off", spellcheck: "false",
    placeholder: "Pseudo#TAG", "aria-label": "Compte secondaire", value,
  });
  const row = el("li", { class: "smurf" }, input,
    el("button", {
      type: "button", class: "btn btn-ghost", text: "Retirer",
      onclick: () => { row.remove(); updateAddButton(); },
    }));
  return row;
}

function updateAddButton() {
  $("#pf-add-smurf").hidden = $("#pf-smurfs").children.length >= MAX_SMURFS;
}

function renderProfile(player) {
  $("#pf-pseudo").value = player.pseudo || "";
  $("#pf-role").value = player.main_role || "";
  $("#pf-riot-id").value = player.riot_id || "";
  $("#pf-smurfs").replaceChildren(...(player.smurfs || []).map(smurfRow));
  updateAddButton();
  $("#profile-status").textContent = [
    STATUS_NAMES[player.status] || player.status,
    player.is_admin ? "admin du site" : null,
  ].filter(Boolean).join(" · ");
}

async function loadProfile() {
  const { data, error } = await db.from("players")
    .select("id, pseudo, main_role, status, is_admin, riot_id, smurfs")
    .eq("id", state.player.id)
    .single();
  if (error) return showError(`Impossible de charger ton profil : ${error.message}`);
  renderProfile(data);
}

async function saveProfile(e) {
  e.preventDefault();   // empêche le rechargement de la page par le formulaire
  profileError("");

  const pseudo = $("#pf-pseudo").value.trim();
  const riotId = $("#pf-riot-id").value.trim();
  const smurfs = [...$("#pf-smurfs").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);

  if (!pseudo) return profileError("Indique un pseudo.");
  const accounts = [riotId, ...smurfs].filter(Boolean);
  const invalid = accounts.find((a) => !isRiotId(a));
  if (invalid) return profileError(`« ${invalid} » n'est pas un Riot ID complet : il faut le pseudo, un #, puis le tag (ex. Pseudo#EUW).`);
  const ids = accounts.map(normId);
  if (new Set(ids).size !== ids.length) return profileError("Le même compte est indiqué deux fois.");
  if (smurfs.length && !riotId) return profileError("Indique ton compte principal avant d'ajouter des comptes secondaires.");

  const button = $("#pf-save");
  button.disabled = true;
  try {
    // Un compte ne peut appartenir qu'à un seul joueur de la team
    const { data: others, error: othersError } = await db.from("players")
      .select("pseudo, riot_id, smurfs").neq("id", state.player.id);
    if (othersError) throw new Error(othersError.message);
    for (const other of others) {
      const taken = [other.riot_id, ...(other.smurfs || [])].map(normId).find((id) => id && ids.includes(id));
      if (taken) {
        return profileError(`Le compte ${accounts[ids.indexOf(taken)]} est déjà indiqué par ${other.pseudo}.`);
      }
    }

    const { data, error } = await db.from("players")
      .update({ pseudo, main_role: $("#pf-role").value || null, riot_id: riotId || null, smurfs })
      .eq("id", state.player.id)
      .select("id, pseudo, main_role, status, is_admin, riot_id, smurfs")
      .single();
    if (error) throw new Error(error.message);

    Object.assign(state.player, { pseudo: data.pseudo, main_role: data.main_role });
    $("#user-name").textContent = data.pseudo;
    renderProfile(data);
    showToast("Profil enregistré");
  } catch (err) {
    profileError(`L'enregistrement a échoué : ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

$("#profile-form").addEventListener("submit", saveProfile);
$("#pf-add-smurf").addEventListener("click", () => {
  if ($("#pf-smurfs").children.length >= MAX_SMURFS) return;
  const row = smurfRow();
  $("#pf-smurfs").append(row);
  updateAddButton();
  row.querySelector("input").focus();
});

startSession(loadProfile);
