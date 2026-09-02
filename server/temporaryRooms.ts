import { nanoid } from "nanoid";

export const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export type TemporaryAlias = string;

type Participant = {
  id: string;
  alias: TemporaryAlias;
};

export type TemporaryMessage = {
  id: string;
  memberId: string;
  alias: TemporaryAlias;
  body: string;
  sentAt: number;
  deliveredBy?: string;
  readBy?: string;
};

type TemporaryMedia = {
  id: string;
  memberId: string;
  alias: TemporaryAlias;
  kind: "voice" | "photo";
  dataUrl: string;
  sentAt: number;
  consumedBy?: string;
};

export type TemporaryMediaSnapshot = Omit<TemporaryMedia, "dataUrl"> & { dataUrl?: string };

type Room = {
  id: string;
  inviteToken: string;
  expiresAt: number;
  host: Participant;
  guest?: Participant;
  messages: TemporaryMessage[];
  media: TemporaryMedia[];
  typing?: { memberId: string; expiresAt: number };

};

export type RoomSnapshot = {
  roomId: string;
  expiresAt: number;
  hostAlias: string;
  guestAlias?: string;
  currentMemberId: string;
  currentAlias: string;
  participantCount: number;
  typingAlias?: string;
  messages: TemporaryMessage[];
  media: TemporaryMediaSnapshot[];
};

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
        sub.onClose(closedReason || "Room ended or expired.");
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
  if (room.host.id !== memberId && room.guest?.id !== memberId) {
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

function removeExpiredRooms(now = Date.now()) {
  rooms.forEach((room, roomId) => {
    if (room.expiresAt <= now) {
      notifyRoomSubscribers(roomId, "Room has expired.");
      rooms.delete(roomId);
    }
  });
}

function requireRoom(roomId: string, inviteToken: string) {
  removeExpiredRooms();
  const room = rooms.get(roomId);
  if (!room || room.inviteToken !== inviteToken) {
    throw new Error("This temporary chat invite is invalid or expired.");
  }
  return room;
}

function snapshot(room: Room, currentMemberId: string): RoomSnapshot {
  if (room.typing && room.typing.expiresAt <= Date.now()) room.typing = undefined;
  const current = room.host.id === currentMemberId ? room.host : room.guest;
  if (!current) throw new Error("You are not a participant in this room.");
  return {
    roomId: room.id,
    expiresAt: room.expiresAt,
    hostAlias: room.host.alias,
    guestAlias: room.guest?.alias,
    currentMemberId,
    currentAlias: current.alias,
    participantCount: room.guest ? 2 : 1,
    typingAlias: room.typing && room.typing.memberId !== currentMemberId
      ? (room.typing.memberId === room.host.id ? room.host.alias : room.guest?.alias)
      : undefined,
    messages: room.messages.slice(),
    media: room.media.map((item) => ({
      ...item,
      dataUrl: item.consumedBy ? undefined : item.dataUrl,
    })),
  };
}

export function createTemporaryRoom(aliasInput: string, clientIp = "default") {
  removeExpiredRooms();
  if (!checkRateLimit(`create:${clientIp}`, 15, 60_000)) {
    throw new Error("Too many room creation requests. Please wait a minute.");
  }
  const alias = validateAlias(aliasInput);
  const room: Room = {
    id: nanoid(16),
    inviteToken: nanoid(32),
    expiresAt: Date.now() + ROOM_TTL_MS,
    host: { id: nanoid(12), alias },
    messages: [],
    media: [],
  };
  rooms.set(room.id, room);
  return {
    ...snapshot(room, room.host.id),
    inviteToken: room.inviteToken,
  };
}

export function joinTemporaryRoom(roomId: string, inviteToken: string, aliasInput: string) {
  const room = requireRoom(roomId, inviteToken);
  if (room.guest) throw new Error("This temporary room already has two participants.");
  const alias = validateAlias(aliasInput);
  room.guest = { id: nanoid(12), alias };
  const snap = snapshot(room, room.guest.id);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function getTemporaryRoom(roomId: string, inviteToken: string, memberId: string) {
  return snapshot(requireRoom(roomId, inviteToken), memberId);
}

export function setTemporaryTyping(roomId: string, inviteToken: string, memberId: string, isTyping: boolean) {
  const room = requireRoom(roomId, inviteToken);
  if (room.host.id !== memberId && room.guest?.id !== memberId) {
    throw new Error("You are not a participant in this room.");
  }
  room.typing = isTyping ? { memberId, expiresAt: Date.now() + 6_000 } : undefined;
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function acknowledgeTemporaryMessages(roomId: string, inviteToken: string, memberId: string) {
  const room = requireRoom(roomId, inviteToken);
  if (room.host.id !== memberId && room.guest?.id !== memberId) {
    throw new Error("You are not a participant in this room.");
  }
  let changed = false;
  room.messages.forEach((message) => {
    if (message.memberId !== memberId && !message.deliveredBy) {
      message.deliveredBy = memberId;
      changed = true;
    }
  });
  const snap = snapshot(room, memberId);
  if (changed) notifyRoomSubscribers(roomId);
  return snap;
}

export function markTemporaryMessagesRead(roomId: string, inviteToken: string, memberId: string, messageIds: string[] = []) {
  const room = requireRoom(roomId, inviteToken);
  if (room.host.id !== memberId && room.guest?.id !== memberId) {
    throw new Error("You are not a participant in this room.");
  }
  const targetIds = new Set(messageIds);
  let changed = false;
  room.messages.forEach((message) => {
    if (message.memberId !== memberId && !message.readBy && (targetIds.size === 0 || targetIds.has(message.id))) {
      message.readBy = memberId;
      changed = true;
    }
  });
  const snap = snapshot(room, memberId);
  if (changed) notifyRoomSubscribers(roomId);
  return snap;
}

export function sendTemporaryMessage(roomId: string, inviteToken: string, memberId: string, bodyInput: string) {
  const room = requireRoom(roomId, inviteToken);
  const member = room.host.id === memberId ? room.host : room.guest?.id === memberId ? room.guest : undefined;
  if (!member) throw new Error("You are not a participant in this room.");
  const body = bodyInput.trim();
  if (!body || body.length > MAX_MESSAGE_LENGTH) throw new Error("Message must contain 1–2,000 characters.");
  room.typing = undefined;
  room.messages.push({ id: nanoid(12), memberId, alias: member.alias, body, sentAt: Date.now() });
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

function getParticipant(room: Room, memberId: string) {
  const member = room.host.id === memberId ? room.host : room.guest?.id === memberId ? room.guest : undefined;
  if (!member) throw new Error("You are not a participant in this room.");
  return member;
}

function validateMedia(kind: "voice" | "photo", dataUrlInput: string) {
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

  const isVoice = allowedAudio.includes(rawMime);
  const isImage = allowedImage.includes(rawMime);

  if (kind === "voice" && !isVoice) {
    if (isImage) throw new Error("Media type does not match the selected action.");
    throw new Error(`Unsupported audio format: ${rawMime}`);
  }
  if (kind === "photo" && !isImage) {
    if (isVoice) throw new Error("Media type does not match the selected action.");
    throw new Error(`Unsupported image format: ${rawMime}`);
  }

  const bytes = Buffer.byteLength(base64Raw, "base64");
  const maxBytes = kind === "voice" ? MAX_VOICE_BYTES : MAX_PHOTO_BYTES;
  if (bytes > maxBytes) {
    throw new Error(`${kind === "voice" ? "Voice note" : "Photo"} is too large.`);
  }

  return `data:${rawMime};base64,${base64Raw}`;
}

export function sendTemporaryMedia(roomId: string, inviteToken: string, memberId: string, kind: "voice" | "photo", dataUrlInput: string) {
  const room = requireRoom(roomId, inviteToken);
  const member = getParticipant(room, memberId);
  const dataUrl = validateMedia(kind, dataUrlInput);
  room.media.push({ id: nanoid(12), memberId, alias: member.alias, kind, dataUrl, sentAt: Date.now() });
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function consumeTemporaryMedia(roomId: string, inviteToken: string, memberId: string, mediaId: string) {
  const room = requireRoom(roomId, inviteToken);
  getParticipant(room, memberId);
  const item = room.media.find((media) => media.id === mediaId);
  if (!item) throw new Error("This media is no longer available.");
  if (item.memberId === memberId) throw new Error("Only the recipient can consume this media.");
  if (item.consumedBy) throw new Error("This media is no longer available.");
  item.consumedBy = memberId;
  const snap = snapshot(room, memberId);
  notifyRoomSubscribers(roomId);
  return snap;
}

export function leaveTemporaryRoom(roomId: string, inviteToken: string, memberId: string) {
  const room = requireRoom(roomId, inviteToken);
  if (room.host.id !== memberId && room.guest?.id !== memberId) {
    throw new Error("You are not a participant in this room.");
  }
  notifyRoomSubscribers(roomId, "A participant left the room.");
  rooms.delete(roomId);
  return { success: true as const };
}

export function clearTemporaryRoomsForTests() {
  rooms.clear();
  subscribers.clear();
  rateLimitMap.clear();
}

export function roomCountForTests() {
  removeExpiredRooms();
  return rooms.size;
}
