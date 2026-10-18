import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { z } from "zod";
import {
  acknowledgeTemporaryMessages,
  createTemporaryRoom,
  getTemporaryRoom,
  joinTemporaryRoom,
  leaveTemporaryRoom,
  markTemporaryMessagesRead,
  sendTemporaryMessage,
  sendTemporaryMedia,
  consumeTemporaryMedia,
  setTemporaryTyping,
  startTemporaryCall,
  joinTemporaryCall,
  endTemporaryCall,
  sendTemporaryCallSignal,
  extendRoomExpiry,
} from "./temporaryRooms";

const roomInput = z.object({
  roomId: z.string().min(8).max(64),
  inviteToken: z.string().min(16).max(96),
  memberId: z.string().min(8).max(32),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  temporary: router({
    create: publicProcedure.input(z.object({ alias: z.string() })).mutation(({ ctx, input }) =>
      createTemporaryRoom(input.alias, ctx.req.ip || "unknown"),
    ),
    join: publicProcedure.input(z.object({
      roomId: z.string(),
      inviteToken: z.string(),
      alias: z.string(),
    })).mutation(({ input }) => joinTemporaryRoom(input.roomId, input.inviteToken, input.alias)),
    get: publicProcedure.input(roomInput).query(({ input }) =>
      getTemporaryRoom(input.roomId, input.inviteToken, input.memberId),
    ),
    send: publicProcedure.input(roomInput.extend({ body: z.string() })).mutation(({ input }) =>
      sendTemporaryMessage(input.roomId, input.inviteToken, input.memberId, input.body),
    ),
    sendMedia: publicProcedure.input(roomInput.extend({ kind: z.enum(["voice", "photo"]), dataUrl: z.string() })).mutation(({ input }) =>
      sendTemporaryMedia(input.roomId, input.inviteToken, input.memberId, input.kind, input.dataUrl),
    ),
    consumeMedia: publicProcedure.input(roomInput.extend({ mediaId: z.string().min(8).max(32) })).mutation(({ input }) =>
      consumeTemporaryMedia(input.roomId, input.inviteToken, input.memberId, input.mediaId),
    ),
    typing: publicProcedure.input(roomInput.extend({ isTyping: z.boolean() })).mutation(({ input }) =>
      setTemporaryTyping(input.roomId, input.inviteToken, input.memberId, input.isTyping),
    ),
    acknowledge: publicProcedure.input(roomInput).mutation(({ input }) =>
      acknowledgeTemporaryMessages(input.roomId, input.inviteToken, input.memberId),
    ),
    markRead: publicProcedure.input(roomInput.extend({ messageIds: z.array(z.string()).default([]) })).mutation(({ input }) =>
      markTemporaryMessagesRead(input.roomId, input.inviteToken, input.memberId, input.messageIds),
    ),
    leave: publicProcedure.input(roomInput).mutation(({ input }) =>
      leaveTemporaryRoom(input.roomId, input.inviteToken, input.memberId),
    ),
    startCall: publicProcedure.input(roomInput.extend({
      kind: z.enum(["audio", "video"]),
      offer: z.string().optional(),
    })).mutation(({ input }) =>
      startTemporaryCall(input.roomId, input.inviteToken, input.memberId, input.kind, input.offer),
    ),
    joinCall: publicProcedure.input(roomInput).mutation(({ input }) =>
      joinTemporaryCall(input.roomId, input.inviteToken, input.memberId),
    ),
    endCall: publicProcedure.input(roomInput).mutation(({ input }) =>
      endTemporaryCall(input.roomId, input.inviteToken, input.memberId),
    ),
    sendSignal: publicProcedure.input(roomInput.extend({
      receiverId: z.string(),
      type: z.enum(["offer", "answer", "ice", "end"]),
      payload: z.string(),
    })).mutation(({ input }) =>
      sendTemporaryCallSignal(input.roomId, input.inviteToken, input.memberId, input.receiverId, input.type, input.payload),
    ),
    extendExpiry: publicProcedure.input(roomInput.extend({
      minutes: z.number().min(1).max(60).default(15),
    })).mutation(({ input }) =>
      extendRoomExpiry(input.roomId, input.inviteToken, input.memberId, input.minutes),
    ),
  }),
});

export type AppRouter = typeof appRouter;
