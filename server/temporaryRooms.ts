export type CallSignal = {
  id: string;
  senderId: string;
  receiverId: string;
  type: 'offer' | 'answer' | 'ice' | 'end';
  payload: string;
  timestamp: number;
};

export type ActiveCall = {
  initiatorId: string;
  initiatorAlias: string;
  targetId?: string;
  kind: 'audio' | 'video';
  startedAt: number;
  participants: string[];
  offer?: string;
  offererId?: string;
  answer?: string;
  answererId?: string;
};

import { nanoid } from "nanoid";

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export type TemporaryAlias = string;

type Participant = {
  id: string;
  alias: TemporaryAlias;
  // A per-participant capability used only for deleting that participant's
  // content. It is returned only to that participant at create/join time and
  // is never included in room snapshots or invite links.
  memberToken: string;
};

export type TemporaryMessage = {
  id: string;
  memberId: string;
  alias: TemporaryAlias;
  body: string;
  sentAt: number;
  deliveredTo: string[];
  readBy: string[];
};

type TemporaryMedia = {
  id: string;
  memberId: string;
  alias: TemporaryAlias;
  kind: "voice" | "photo" | "video" | "document";
  // Voice notes are view-once for recipients. The sender always retains access
  // to their own copy; photos and videos follow the same recipient-only rule.
  viewOnce?: boolean;
  fileName?: string;
  mimeType?: string;
  dataUrl?: string; // made optional so we can delete it when everyone consumed
  sentAt: number;
  consumedBy: string[];
};

export type TemporaryMediaSnapshot = Omit<TemporaryMedia, "dataUrl"> & { dataUrl?: string };

export type ScreenshotShortcutNotice = {
  id: string;
  memberId: string;
  alias: TemporaryAlias;
  sentAt: number;
};

type Room = {
  id: string;
  inviteToken: string;
  host: Participant;
  guests: Participant[];
  messages: TemporaryMessage[];
  media: TemporaryMedia[];
  screenshotShortcutNotices: ScreenshotShortcutNotice[];
  typing: { memberId: string; expiresAt: number }[];
  call?: ActiveCall;
  signals: CallSignal[];
};

export type RoomSnapshot = {
  roomId: string;
  hostAlias: string;
  guestAlias?: string;
  guestAliases: string[];
  currentMemberId: string;
  currentAlias: string;
  participantCount: number;
  typingAlias?: string;
  typingAliases: string[];
  messages: TemporaryMessage[];
  media: TemporaryMediaSnapshot[];
  screenshotShortcutNotices: ScreenshotShortcutNotice[];
  call?: ActiveCall;
  signals: CallSignal[];
};

export type TemporaryCallIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const DEFAULT_TURN_SERVER: TemporaryCallIceServer = {
  urls: [
    "turn:staticauth.openrelay.metered.ca:80",
    "turn:staticauth.openrelay.metered.ca:80?transport=tcp",
    "turn:staticauth.openrelay.metered.ca:443",
    "turn:staticauth.openrelay.metered.ca:443?transport=tcp",
    "turns:staticauth.openrelay.metered.ca:443?transport=tcp",
  ],
  username: "openrelayproject",
  credential: "openrelayprojectsecret",
};

/**
 * Allow deployments to use their own TURN relay without baking credentials
 * into the client bundle. TURN_URLS accepts a comma-separated list.
 */
export function getTemporaryCallIceServers(): TemporaryCallIceServer[] {
  const configuredUrls = (process.env.TURN_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.startsWith("turn:") || url.startsWith("turns:"));
  const username = process.env.TURN_USERNAME?.trim();
  const credential = process.env.TURN_CREDENTIAL;
  const configuredTurn = configuredUrls.length && username && credential
    ? [{ urls: configuredUrls, username, credential }]
    : [DEFAULT_TURN_SERVER];

  return [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
    ...configuredTurn,
  ];
}

const rooms = new Map<string, Room>();

type Subscriber = {
  memberId: string;
  onUpdate: (snapshot: RoomSnapshot) => void;
  onClose: (reason: string) => void;
};

const subscribers = new Map<string, Set<Subscriber>>();

// In-memory sliding-window rate limiter
const rateLimitMap = new Map<string, number[]>();

export function checkRateLimit(key: string, maxHits = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(key) || []).filter((time) => now - time < windowMs);
  if (timestamps.length >= maxHits) {
    return false;
  }
  timestamps.push(now);
  rateLimitMap.set(key, timestamps);
  return true;
}

export function notifyRoomSubscribers(roomId: string, closedReason?: string) {
  const roomSubs = subscribers.get(roomId);
  if (!roomSubs || roomSubs.size === 0) return;
  const room = rooms.get(roomId);
  if (!room || closedReason) {
    roomSubs.forEach((sub) => {
      try {
        sub.onClose(closedReason || "The room has been closed.");
      } catch {
        /* ignore */
      }
    });
    subscribers.delete(roomId);
    return;
  }
  roomSubs.forEach((sub) => {
    try {
      const snap = snapshot(room, sub.memberId);
      sub.onUpdate(snap);
    } catch {
      /* ignore */
    }
  });
}

export function subscribeToRoomUpdates(
  roomId: string,
  inviteToken: string,
  memberId: string,
  onUpdate: (snapshot: RoomSnapshot) => void,
  onClose: (reason: string) => void
): () => void {
  const room = requireRoom(roomId, inviteToken);
  // Verify member
  const isParticipant = room.host.id === memberId || room.guests.some(g => g.id === memberId);
  if (!isParticipant) {
    throw new Error("You are not a participant in this room.");
  }
  if (!subscribers.has(roomId)) {
    subscribers.set(roomId, new Set());
  }
  const sub: Subscriber = { memberId, onUpdate, onClose };
  subscribers.get(roomId)!.add(sub);

  // Send initial snapshot immediately
  onUpdate(snapshot(room, memberId));

  return () => {
    const subs = subscribers.get(roomId);
    if (subs) {
      subs.delete(sub);
      if (subs.size === 0) subscribers.delete(roomId);
    }
  };
}

export function validateAlias(alias: string) {
  const normalized = alias.trim();
  if (!/^[A-Za-z0-9 ._-]{2,32}$/.test(normalized)) {
    throw new Error("Alias must be 2–32 characters using letters, numbers, spaces, dots, dashes, or underscores.");
  }
  return normalized;
}

function requireRoom(roomId: string, inviteToken: string) {
  const room = rooms.get(roomId);
  if (!room || room.inviteToken !== inviteToken) {
    throw new Error("This room is invalid, closed, or no longer available.");
  }
  return room;
}

function snapshot(room: Room, currentMemberId: string): RoomSnapshot {
  const now = Date.now();
  room.typing = room.typing.filter(t => t.expiresAt > now);
  room.screenshotShortcutNotices = room.screenshotShortcutNotices.filter((notice) => now - notice.sentAt < 60_000);
  
  const current = room.host.id === currentMemberId ? room.host : room.guests.find(g => g.id === currentMemberId);
  if (!current) throw new Error("You are not a participant in this room.");
  
  const typingAliases = room.typing
    .filter(t => t.memberId !== currentMemberId)
    .map(t => {
      if (t.memberId === room.host.id) return room.host.alias;
      const g = room.guests.find(g => g.id === t.memberId);
      return g ? g.alias : undefined;
    })
    .filter((a): a is string => !!a);

  return {
    roomId: room.id,
    hostAlias: room.host.alias,
    guestAlias: room.guests[0]?.alias,
    guestAliases: room.guests.map(g => g.alias),
    currentMemberId,
    currentAlias: current.alias,
    participantCount: 1 + room.guests.length,
    typingAlias: typingAliases[0],
    typingAliases: Array.from(new Set(typingAliases)),
    messages: room.messages.map(m => ({ ...m, deliveredTo: [...m.deliveredTo], readBy: [...m.readBy] })),
    media: room.media.map((item) => ({
      ...item,
      consumedBy: [...item.consumedBy],
      // Consumption is per recipient; never revoke the sender's retained copy.
      dataUrl: item.memberId !== currentMemberId && item.consumedBy.includes(currentMemberId) ? undefined : item.dataUrl,
    })),
    screenshotShortcutNotices: room.screenshotShortcutNotices.map((notice) => ({ ...notice })),
    call: room.call
      ? (room.call.targetId && room.call.targetId !== currentMemberId && room.call.initiatorId !== currentMemberId)
        ? undefined
        : { ...room.call, participants: [...room.call.participants] }
      : undefined,
    signals: (room.signals || []).filter(s =>
      s.receiverId === currentMemberId ||
      (s.receiverId === 'all' && s.senderId !== currentMemberId && (room.call ? room.call.participants.includes(currentMemberId) : true))
    ),
  };
}

export function createTemporaryRoom(aliasInput: string, clientIp = "default") {
  if (!checkRateLimit(`create:${clientIp}`, 15, 60_000)) {
    throw new Error("Too many room creation requests. Please wait a minute.");
  }
  const alias = validateAlias(aliasInput);
  const host: Participant = { id: nanoid(12), alias, memberToken: nanoid(32) };
  const room: Room = {
    id: nanoid(16),
    inviteToken: nanoid(32),
    host,
    guests: [],
    messages: [],
    media: [],
    screenshotShortcutNotices: [],
    typing: [],
    signals: [],
  };
  rooms.set(room.id, room);
  return {
    ...snapshot(room, host.id),
    inviteToken: room.inviteToken,
    memberToken: host.memberToken,
  };
}

export function joinTemporaryRoom(roomId: string, inviteToken: string, aliasInput: string) {
  const room = requireRoom(roomId, inviteToken);
  // Optional: Limit participants to prevent abuse
  if (room.guests.length >= 49) throw new Error("This temporary room has reached the maximum of 50 participants.");
  
  const alias = validateAlias(aliasInput);
  const newGuest: Participant = { id: nanoid(12), alias, memberToken: nanoid(32) };
  room.guests.push(newGuest);
  
  const snap = snapshot(room, newGuest.id);
  notifyRoomSubscribers(roomId);
  return { ...snap, memberToken: newGuest.memberToken };
}

export function getTemporaryRoom(roomId: string, inviteToken: string, memberId: string) {
  return snapshot(requireRoom(roomId, inviteToken), memberId);
}

export function reportTemporaryScreenshotShortcut(
  roomId: string,
  inviteToken: string,
  memberId: string,
  memberToken: string,
) {
  const room = requireRoom(roomId, inviteToken);
  const member = [room.host, ...room.guests].find((participant) => participant.memberToken === memberToken);
  if (!member || member.id !== memberId) {
    throw new Error("You do not have permission to report an event for this room participant.");
  }

  if (!checkRateLimit(`screenshot-shortcut:${roomId}:${memberId}`, 1, 5_000)) {
    return snapshot(room, memberId);
  }

  const sentAt = Date.now();
  room.screenshotShortcutNotices = room.screenshotShortcutNotices.filter((notice) => sentAt - notice.sentAt < 60_000);
  room.screenshotShortcutNotices.push({
    id: nanoid(12),
    memberId,
    alias: member.alias,
    sentAt,
  });
  if (room.screenshotShortcutNotices.length > 50) room.screenshotShortcutNotices.shift();

  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function setTemporaryTyping(roomId: string, inviteToken: string, memberId: string, isTyping: boolean) {
  const room = requireRoom(roomId, inviteToken);
  const isParticipant = room.host.id === memberId || room.guests.some(g => g.id === memberId);
  if (!isParticipant) {
    throw new Error("You are not a participant in this room.");
  }
  
  room.typing = room.typing.filter(t => t.memberId !== memberId);
  if (isTyping) {
    room.typing.push({ memberId, expiresAt: Date.now() + 6_000 });
  }
  
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function acknowledgeTemporaryMessages(roomId: string, inviteToken: string, memberId: string) {
  const room = requireRoom(roomId, inviteToken);
  const isParticipant = room.host.id === memberId || room.guests.some(g => g.id === memberId);
  if (!isParticipant) {
    throw new Error("You are not a participant in this room.");
  }
  
  let changed = false;
  room.messages.forEach((message) => {
    if (message.memberId !== memberId && !message.deliveredTo.includes(memberId)) {
      message.deliveredTo.push(memberId);
      changed = true;
    }
  });
  const snap = snapshot(room, memberId);
  if (changed) notifyRoomSubscribers(roomId);
  return snap;
}

export function markTemporaryMessagesRead(roomId: string, inviteToken: string, memberId: string, messageIds: string[] = []) {
  const room = requireRoom(roomId, inviteToken);
  const isParticipant = room.host.id === memberId || room.guests.some(g => g.id === memberId);
  if (!isParticipant) {
    throw new Error("You are not a participant in this room.");
  }
  
  const targetIds = new Set(messageIds);
  let changed = false;
  room.messages.forEach((message) => {
    if (message.memberId !== memberId && !message.readBy.includes(memberId) && (targetIds.size === 0 || targetIds.has(message.id))) {
      message.readBy.push(memberId);
      changed = true;
    }
  });
  const snap = snapshot(room, memberId);
  if (changed) notifyRoomSubscribers(roomId);
  return snap;
}

export function sendTemporaryMessage(roomId: string, inviteToken: string, memberId: string, bodyInput: string) {
  const room = requireRoom(roomId, inviteToken);
  const member = room.host.id === memberId ? room.host : room.guests.find(g => g.id === memberId);
  if (!member) throw new Error("You are not a participant in this room.");
  
  const body = bodyInput.trim();
  if (!body || body.length > MAX_MESSAGE_LENGTH) throw new Error("Message must contain 1–2,000 characters.");
  room.typing = room.typing.filter(t => t.memberId !== memberId);
  room.messages.push({ 
    id: nanoid(12), 
    memberId, 
    alias: member.alias, 
    body, 
    sentAt: nextContentTimestamp(room),
    deliveredTo: [],
    readBy: []
  });
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

function getParticipant(room: Room, memberId: string) {
  const member = room.host.id === memberId ? room.host : room.guests.find(g => g.id === memberId);
  if (!member) throw new Error("You are not a participant in this room.");
  return member;
}

function nextContentTimestamp(room: Room) {
  const latestMessage = room.messages[room.messages.length - 1]?.sentAt ?? 0;
  const latestMedia = room.media[room.media.length - 1]?.sentAt ?? 0;
  return Math.max(Date.now(), Math.max(latestMessage, latestMedia) + 1);
}

function validateMedia(kind: "voice" | "photo" | "video" | "document", dataUrlInput: string) {
  if (typeof dataUrlInput !== "string" || !dataUrlInput.startsWith("data:")) {
    throw new Error("Unsupported media format.");
  }

  const commaIdx = dataUrlInput.indexOf(",");
  if (commaIdx === -1) throw new Error("Unsupported media format.");

  const header = dataUrlInput.slice(0, commaIdx);
  const base64Raw = dataUrlInput.slice(commaIdx + 1).replace(/\s+/g, "");

  if (!header.endsWith(";base64")) throw new Error("Media must be base64 encoded.");

  const rawMime = header.slice(5, -7).split(";")[0].trim().toLowerCase();

  const allowedAudio = [
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/wav",
    "audio/aac",
    "audio/m4a",
    "audio/x-m4a",
    "audio/mpeg",
    "audio/mp3",
  ];
  const allowedImage = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
    "image/heif",
  ];
  const allowedVideo = [
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/3gpp",
    "video/x-matroska",
    "video/ogg",
  ];

  const isVoice = allowedAudio.includes(rawMime);
  const isImage = allowedImage.includes(rawMime);
  const isVideo = allowedVideo.includes(rawMime);
  const isDocument = rawMime.startsWith("application/") || rawMime.startsWith("text/");

  if (kind === "voice" && !isVoice) {
    if (isImage || isVideo) throw new Error("Media type does not match the selected action.");
    throw new Error(`Unsupported audio format: ${rawMime}`);
  }
  if (kind === "photo" && !isImage) {
    if (isVoice || isVideo) throw new Error("Media type does not match the selected action.");
    throw new Error(`Unsupported image format: ${rawMime}`);
  }
  if (kind === "video" && !isVideo) {
    if (isVoice || isImage) throw new Error("Media type does not match the selected action.");
    throw new Error(`Unsupported video format: ${rawMime}`);
  }
  if (kind === "document" && (!isDocument || isImage || isVideo || isVoice)) {
    throw new Error(`Unsupported document format: ${rawMime}`);
  }

  const bytes = Buffer.byteLength(base64Raw, "base64");
  const maxBytes = kind === "voice" ? MAX_VOICE_BYTES : kind === "photo" ? MAX_PHOTO_BYTES : kind === "video" ? MAX_VIDEO_BYTES : MAX_DOCUMENT_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`${kind === "voice" ? "Voice note" : kind === "photo" ? "Photo" : kind === "video" ? "Video" : "Document"} is too large.`);
  }

  return `data:${rawMime};base64,${base64Raw}`;
}

export function sendTemporaryMedia(
  roomId: string,
  inviteToken: string,
  memberId: string,
  kind: "voice" | "photo" | "video" | "document",
  dataUrlInput: string,
  fileName?: string,
  mimeType?: string,
  // Accepted for old clients, but no recipient can opt out of view-once.
  _viewOnce?: boolean,
) {
  const room = requireRoom(roomId, inviteToken);
  const member = getParticipant(room, memberId);
  const dataUrl = validateMedia(kind, dataUrlInput);
  const safeFileName = fileName?.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 180) || "document";
  room.media.push({
    id: nanoid(12),
    memberId,
    alias: member.alias,
    kind,
    ...(kind === "voice" ? { viewOnce: true } : {}),
    ...(kind === "document" ? { fileName: safeFileName, mimeType: mimeType || dataUrl.slice(5, dataUrl.indexOf(";")) } : {}),
    dataUrl,
    sentAt: nextContentTimestamp(room),
    consumedBy: []
  });
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function consumeTemporaryMedia(roomId: string, inviteToken: string, memberId: string, mediaId: string) {
  const room = requireRoom(roomId, inviteToken);
  getParticipant(room, memberId);
  const item = room.media.find((media) => media.id === mediaId);
  if (!item) throw new Error("This media is no longer available.");
  if (item.kind === "document") throw new Error("Documents remain available until the room is closed.");
  if (item.memberId === memberId) throw new Error("Only the recipient can consume this media.");
  if (item.consumedBy.includes(memberId)) throw new Error("This media is no longer available.");
  
  item.consumedBy.push(memberId);
  
  // Keep the server-side payload for the sender's copy. Each recipient's
  // snapshot omits it as soon as that recipient consumes the media.
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function deleteTemporaryContent(
  roomId: string,
  inviteToken: string,
  memberToken: string,
  contentType: "message" | "media",
  contentId: string,
) {
  const room = requireRoom(roomId, inviteToken);
  const member = [room.host, ...room.guests].find((participant) => participant.memberToken === memberToken);
  if (!member) throw new Error("You do not have permission to delete content in this room.");

  if (contentType === "message") {
    const index = room.messages.findIndex((item) => item.id === contentId);
    if (index < 0) throw new Error("This message is no longer available.");
    if (room.messages[index]!.memberId !== member.id) {
      throw new Error("You can only delete your own messages.");
    }
    room.messages.splice(index, 1);
  } else {
    const index = room.media.findIndex((item) => item.id === contentId);
    if (index < 0) throw new Error("This media is no longer available.");
    if (room.media[index]!.memberId !== member.id) {
      throw new Error("You can only delete your own media.");
    }
    room.media.splice(index, 1);
  }

  const snap = snapshot(room, member.id);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function leaveTemporaryRoom(roomId: string, inviteToken: string, memberId: string) {
  const room = requireRoom(roomId, inviteToken);
  const isParticipant = room.host.id === memberId || room.guests.some(g => g.id === memberId);
  if (!isParticipant) {
    throw new Error("You are not a participant in this room.");
  }
  
  // Actually, if host leaves, should we close the room? Yes.
  // If guest leaves, we could just remove them from the guests array.
  if (room.call && room.call.participants.includes(memberId)) {
    const remainingCallParticipants = room.call.participants.filter((id) => id !== memberId);
    if (remainingCallParticipants.length < 2) {
      room.call = undefined;
      room.signals = [];
    } else {
      room.call.participants = remainingCallParticipants;
    }
  }
  if (room.host.id === memberId) {
    notifyRoomSubscribers(roomId, "The host closed the room.");
    rooms.delete(roomId);
  } else {
    room.guests = room.guests.filter(g => g.id !== memberId);
    if (room.guests.length === 0) {
      notifyRoomSubscribers(roomId, "The room was closed.");
      rooms.delete(roomId);
    } else {
      notifyRoomSubscribers(roomId);
    }
  }
  
  return { success: true as const };
}

export function clearTemporaryRoomsForTests() {
  rooms.clear();
  subscribers.clear();
  rateLimitMap.clear();
}

export function roomCountForTests() {
  return rooms.size;
}

export function startTemporaryCall(
  roomId: string,
  inviteToken: string,
  memberId: string,
  kind: 'audio' | 'video',
  offer?: string,
  targetId?: string
) {
  const room = requireRoom(roomId, inviteToken);
  const participant = getParticipant(room, memberId);
  if (room.guests.length === 0) throw new Error("A friend must join the room before you can call.");
  if (room.call) throw new Error("A call is already active in this room.");
  if (targetId && ![room.host, ...room.guests].some((candidate) => candidate.id === targetId)) {
    throw new Error("The selected call recipient is not in this room.");
  }
  room.call = {
    initiatorId: memberId,
    initiatorAlias: participant.alias,
    targetId,
    kind,
    startedAt: Date.now(),
    participants: [memberId],
    offer,
    ...(offer ? { offererId: memberId } : {}),
  };
  room.signals = [];
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function joinTemporaryCall(roomId: string, inviteToken: string, memberId: string) {
  const room = requireRoom(roomId, inviteToken);
  getParticipant(room, memberId);
  if (!room.call) throw new Error("No active call in this room.");
  if (room.call.targetId && room.call.targetId !== memberId && room.call.initiatorId !== memberId) {
    throw new Error("This call is directed to another participant.");
  }
  if (!room.call.participants.includes(memberId)) {
    if (room.call.participants.length >= 2) {
      throw new Error("Call already has two participants.");
    }
    room.call.participants.push(memberId);
    room.call.targetId = memberId;
  }
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function endTemporaryCall(roomId: string, inviteToken: string, memberId: string) {
  const room = requireRoom(roomId, inviteToken);
  getParticipant(room, memberId);
  if (room.call) {
    room.call = undefined;
    room.signals = [];
  }
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function sendTemporaryCallSignal(
  roomId: string,
  inviteToken: string,
  memberId: string,
  receiverId: string,
  type: 'offer' | 'answer' | 'ice' | 'end',
  payload: string
) {
  const room = requireRoom(roomId, inviteToken);
  getParticipant(room, memberId);
  if (!room.call) throw new Error("There is no active call to signal.");
  if (!room.call.participants.includes(memberId)) {
    throw new Error("Join the call before sending call signals.");
  }
  const remoteParticipants = room.call.participants.filter((id) => id !== memberId);
  if (type === "end") {
    if (receiverId !== "all" && !remoteParticipants.includes(receiverId)) {
      throw new Error("The call signal recipient is not a participant in this call.");
    }
  } else if (remoteParticipants.length !== 1 || receiverId !== remoteParticipants[0]) {
    throw new Error("The call signal recipient is not a participant in this call.");
  }
  if (!room.signals) room.signals = [];

  // Anchor the current negotiation in the call snapshot so it can be recovered
  // after a transient stream/SSE interruption. Either peer may offer during
  // renegotiation (for example, when adding a camera to an audio call).
  if (type === "offer") {
    room.call.offer = payload;
    room.call.offererId = memberId;
    room.call.answer = undefined;
    room.call.answererId = undefined;
  }
  if (type === "answer") {
    room.call.answer = payload;
    room.call.answererId = memberId;
    try {
      const description = JSON.parse(payload) as { sdp?: unknown };
      const hasActiveVideo = typeof description.sdp === "string" && description.sdp
        .split(/\r?\n/)
        .some((line) => {
          if (!line.startsWith("m=video ")) return false;
          const port = Number(line.split(/\s+/, 2)[1]?.split("/")[0]);
          return Number.isFinite(port) && port > 0;
        });
      if (hasActiveVideo) room.call.kind = "video";
    } catch {
      // Signaling payloads are validated by the WebRTC peers; ignore malformed SDP here.
    }
  }

  // Bound the per-call signal history while retaining recent negotiations and
  // candidates. The current offer and answer also remain anchored on room.call.
  if (room.signals.length > 200) {
    const retained = new Set([
      ...room.signals.filter((signal) => signal.type !== "ice").slice(-100),
      ...room.signals.filter((signal) => signal.type === "ice").slice(-100),
    ].map((signal) => signal.id));
    room.signals = room.signals.filter((signal) => retained.has(signal.id));
  }

  room.signals.push({
    id: nanoid(10),
    senderId: memberId,
    receiverId,
    type,
    payload,
    timestamp: Date.now()
  });
  notifyRoomSubscribers(roomId);
  return { success: true as const };
}
