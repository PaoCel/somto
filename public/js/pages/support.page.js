import { onAuth } from "../services/auth.service.js";
import {
  ensureMySupportThread,
  listenLatestThreadMessages,
  sendSupportThreadMessage,
} from "../api/threads.api.js";

const isEnglish = document.documentElement.lang.toLowerCase().startsWith("en");

const copy = isEnglish ? {
  connecting: "Connecting…",
  live: "Live",
  offline: "Offline",
  signedOutTitle: "Sign in to start the chat",
  signedOutBody: "Your conversation stays private and follows you across your devices.",
  signIn: "Sign in to chat",
  loading: "Opening your support chat…",
  empty: "Write your first message. We will reply here.",
  you: "You",
  support: "Somto Support",
  placeholder: "Write a message…",
  send: "Send",
  sending: "Sending…",
  loadError: "The chat is temporarily unavailable. You can still email support@somto.it.",
  sendError: "The message was not sent. Check your connection and try again.",
  tooLong: "Keep the message under 2,000 characters.",
} : {
  connecting: "Connessione…",
  live: "In tempo reale",
  offline: "Offline",
  signedOutTitle: "Accedi per iniziare la chat",
  signedOutBody: "La conversazione resta privata e ti segue su tutti i tuoi dispositivi.",
  signIn: "Accedi e scrivici",
  loading: "Apro la tua chat di assistenza…",
  empty: "Scrivi il primo messaggio. Ti risponderemo qui.",
  you: "Tu",
  support: "Assistenza Somto",
  placeholder: "Scrivi un messaggio…",
  send: "Invia",
  sending: "Invio…",
  loadError: "La chat non è disponibile in questo momento. Puoi sempre scrivere a support@somto.it.",
  sendError: "Il messaggio non è stato inviato. Controlla la connessione e riprova.",
  tooLong: "Mantieni il messaggio entro 2.000 caratteri.",
};

const chatRoot = document.querySelector("#supportChat");
const chatStatus = document.querySelector("#supportChatStatus");
const chatLoading = document.querySelector("#supportChatLoading");
const chatSignedOut = document.querySelector("#supportChatSignedOut");
const chatSignedOutTitle = document.querySelector("#supportChatSignedOutTitle");
const chatSignedOutBody = document.querySelector("#supportChatSignedOutBody");
const chatSignIn = document.querySelector("#supportChatSignIn");
const chatConversation = document.querySelector("#supportChatConversation");
const chatMessages = document.querySelector("#supportChatMessages");
const chatError = document.querySelector("#supportChatError");
const chatForm = document.querySelector("#supportChatForm");
const chatInput = document.querySelector("#supportChatInput");
const chatSend = document.querySelector("#supportChatSend");
const chatHandoff = document.querySelector("#supportChatHandoff");

let currentUser = null;
let activeThreadId = "";
let openingUid = "";
let stopMessages = null;
let initialMessagesRendered = false;

function setHidden(element, hidden) {
  if (element) element.hidden = hidden;
}

function setStatus(label, mode) {
  if (!chatStatus) return;
  chatStatus.textContent = label;
  chatStatus.dataset.mode = mode;
}

function setError(message = "") {
  if (!chatError) return;
  chatError.textContent = message;
  chatError.hidden = !message;
}

function timestampDate(value) {
  const date = value?.toDate?.();
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function formatMessageTime(value) {
  const date = timestampDate(value);
  if (!date) return "";
  try {
    return new Intl.DateTimeFormat(isEnglish ? "en" : "it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch (_) {
    return "";
  }
}

function isNearBottom() {
  if (!chatMessages) return true;
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 90;
}

function scrollToLatest() {
  if (!chatMessages) return;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function buildMessage(message) {
  const mine = message?.uid === currentUser?.uid;
  const row = document.createElement("article");
  row.className = `support-chat-message${mine ? " is-mine" : ""}`;

  const meta = document.createElement("div");
  meta.className = "support-chat-message-meta";

  const sender = document.createElement("span");
  sender.textContent = mine ? copy.you : copy.support;
  meta.appendChild(sender);

  const time = formatMessageTime(message?.createdAt);
  if (time) {
    const timeElement = document.createElement("time");
    timeElement.textContent = time;
    const date = timestampDate(message?.createdAt);
    if (date) timeElement.dateTime = date.toISOString();
    meta.appendChild(timeElement);
  }

  const bubble = document.createElement("p");
  bubble.className = "support-chat-message-bubble";
  bubble.textContent = String(message?.text || "");

  row.append(meta, bubble);
  return row;
}

function renderMessages(messages = []) {
  if (!chatMessages) return;
  const shouldStick = !initialMessagesRendered || isNearBottom();
  const fragment = document.createDocumentFragment();

  if (!messages.length) {
    const empty = document.createElement("p");
    empty.className = "support-chat-empty";
    empty.textContent = copy.empty;
    fragment.appendChild(empty);
  } else {
    messages.forEach((message) => fragment.appendChild(buildMessage(message)));
  }

  chatMessages.replaceChildren(fragment);
  if (shouldStick) requestAnimationFrame(scrollToLatest);
  initialMessagesRendered = true;
}

function showSignedOut() {
  currentUser = null;
  activeThreadId = "";
  stopMessages?.();
  stopMessages = null;
  initialMessagesRendered = false;
  setHidden(chatLoading, true);
  setHidden(chatConversation, true);
  setHidden(chatSignedOut, false);
  setStatus(navigator.onLine ? copy.live : copy.offline, navigator.onLine ? "live" : "offline");
}

async function openChat(user) {
  currentUser = user;
  openingUid = user.uid;
  setHidden(chatSignedOut, true);
  setHidden(chatConversation, true);
  setHidden(chatLoading, false);
  setError("");
  setStatus(copy.connecting, "connecting");

  try {
    const result = await ensureMySupportThread();
    if (currentUser?.uid !== user.uid) return;

    activeThreadId = String(result?.threadId || `support_${user.uid}`);
    if (chatHandoff) {
      const handoffURL = new URL("/thread.html", window.location.origin);
      handoffURL.searchParams.set("tid", activeThreadId);
      chatHandoff.href = handoffURL.toString();
    }
    stopMessages?.();
    initialMessagesRendered = false;
    stopMessages = listenLatestThreadMessages(activeThreadId, {
      max: 120,
      onChange: (messages) => {
        renderMessages(messages);
        setHidden(chatLoading, true);
        setHidden(chatConversation, false);
        setStatus(navigator.onLine ? copy.live : copy.offline, navigator.onLine ? "live" : "offline");
      },
      onError: () => {
        setHidden(chatLoading, true);
        setHidden(chatConversation, false);
        setError(copy.loadError);
        setStatus(copy.offline, "offline");
      },
    });
  } catch (error) {
    console.error("[support] open chat failed", error);
    setHidden(chatLoading, true);
    setHidden(chatConversation, false);
    setError(copy.loadError);
    setStatus(copy.offline, "offline");
  } finally {
    if (openingUid === user.uid) openingUid = "";
  }
}

function updateNetworkStatus() {
  setStatus(navigator.onLine ? copy.live : copy.offline, navigator.onLine ? "live" : "offline");
  if (chatInput) chatInput.disabled = !navigator.onLine || !currentUser;
  if (chatSend) chatSend.disabled = !navigator.onLine || !currentUser;
}

chatForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = String(chatInput?.value || "").trim();
  if (!text || !activeThreadId || !currentUser) return;
  if (text.length > 2000) {
    setError(copy.tooLong);
    return;
  }

  setError("");
  chatInput.disabled = true;
  chatSend.disabled = true;
  chatSend.textContent = copy.sending;

  try {
    await sendSupportThreadMessage({ threadId: activeThreadId, text });
    chatInput.value = "";
    chatInput.style.height = "auto";
    requestAnimationFrame(scrollToLatest);
  } catch (error) {
    console.error("[support] send message failed", error);
    setError(copy.sendError);
  } finally {
    chatInput.disabled = !navigator.onLine;
    chatSend.disabled = !navigator.onLine;
    chatSend.textContent = copy.send;
    chatInput.focus();
  }
});

chatInput?.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 132)}px`;
});

window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);

if (chatRoot) {
  chatSignedOutTitle.textContent = copy.signedOutTitle;
  chatSignedOutBody.textContent = copy.signedOutBody;
  chatSignIn.textContent = copy.signIn;
  chatLoading.textContent = copy.loading;
  chatInput.placeholder = copy.placeholder;
  chatSend.textContent = copy.send;
  setStatus(copy.connecting, "connecting");

  onAuth((user) => {
    if (!user) {
      showSignedOut();
      return;
    }
    if (currentUser?.uid === user.uid && (activeThreadId || openingUid === user.uid)) return;
    void openChat(user);
  });
}

window.addEventListener("pagehide", () => stopMessages?.(), { once: true });
