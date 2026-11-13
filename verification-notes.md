# VeilChat verification notes

## Current implementation and verification (2026-11-10)

- Removed the automatic room lifetime and expiry-extension controls. New invites omit expiry timestamps; legacy invite payloads with past timestamps remain parseable.
- The browser saves the active room credentials locally, restores them after a page refresh, and retains them through temporary network/query failures while SSE and fallback polling reconnect. An explicit offline logout is queued locally and retried on reconnect/app start.
- Audio/video calling, responsive chat controls, typing presence, copy/paste, view-once media, and native Android `FLAG_SECURE` protections are implemented. The call hook no longer starts its missing-call teardown before the server confirms an active call; signaling snapshots are serialized, negotiation errors are surfaced, and a tap-to-enable-audio fallback is available.
- View-once photos no longer auto-close on a countdown; they remain open until dismissed or the app is backgrounded. Videos close when playback ends or the viewer dismisses them. The composer capture/expiry notice was removed.
- `corepack pnpm check` passed; `corepack pnpm test` passed (14 tests); `corepack pnpm build` passed; `git diff --check` passed. The production build reports a large JavaScript chunk warning.
- The live preview smoke test returned HTTP 200 for `/` and `/api/health`.
- Added `scripts/keep-render-awake.mjs` and a GitHub Actions workflow scheduled every 5 minutes, with retries and a health check. The script was smoke-tested against the local preview; an actual scheduled GitHub Actions run against Render was not run here. The previous 14-minute workflow's recent run history showed multi-hour gaps, so GitHub scheduling is best-effort, not a no-cold-start guarantee. The updated schedule takes effect from the default branch after merge and may also be delayed by GitHub.
- The server already self-pings its Render URL while awake, and the client pings on page load; the scheduled workflow is the external wake-up path.
- No Android Gradle/device build or current browser visual/inter-device call test was run.
- Room state and transcripts remain in server memory, not the database. A server process restart still loses active rooms; refresh/network recovery works only while that process retains the room.

## Historical visual notes (before room-timer removal)

The following preview observations document earlier designs and are retained as history; countdown/timer references below no longer describe the current room UI.

The managed preview loaded the cyberpunk landing page with the alias-first CTA, bold cyan and magenta display typography, HUD corner brackets, protocol steps, participant/timer/memory indicators, and the privacy-boundary warning.

A live preview test entered the alias `NeonWisp` and created a temporary room successfully. The room screen showed a 30-minute countdown, `END CHAT`, a waiting state, a generated scannable QR code, `Share`, `Download QR`, `Copy link`, and `Scan an invite` controls. The QR invitation was visually legible in the desktop preview.

A live preview test entered `NeonWisp` and created a temporary room. The host view displayed the QR code, 30:00 expiry, and share/download/copy controls. A clean API-created invite opened the recipient review state, showing `HostSignal` as the host alias, a 29:53 countdown, and the `JOIN TEMPORARY ROOM` action.

The managed preview recipient flow passed. Opening the invite showed `HostSignal` for review; entering `BlueGuest` and joining transitioned to `Chatting with HostSignal`, displayed `You are connected as BlueGuest`, kept the 29:25 countdown, enabled the composer, and retained the QR/share panel.

In the managed preview, the guest composer accepted `Hello from BlueGuest` while the room remained connected as `BlueGuest` with a live countdown and QR invitation panel. The typed message was visible in the room UI before submission; the server and unit tests cover delivery semantics.

Clicking the send control submitted `Hello from BlueGuest`. The message rendered in the room under the `BlueGuest` alias, confirming the active composer and room-only message rendering in the managed preview.

Clicking `END CHAT` in the managed preview returned to the clean landing page and showed `Room ended and cleared`. The former room transcript was no longer visible.

Interaction update verification: the managed preview opened a fresh invite for `SignalHost`, accepted guest alias `PulseGuest`, and entered the connected room. The guest message composer submitted `Hello from BlueGuest` and rendered the message under the guest alias. The room teardown returned to the clean landing state. Typing presence and read-receipt lifecycle are covered by the server test suite; the browser preview was refreshed after the API-driven signal test, so the transient indicator itself was not retained after navigation.

The connected preview room was verified as `ReadGuest` chatting with `ReadHost`. Sending `Read receipt check` rendered the message under the guest alias with the explicit `SENT` receipt, confirming the initial state is no longer inferred from connection status.

Interaction-state verification completed in the managed preview using `ProofHost` and `ProofGuest`. The connected guest room visibly showed `ProofHost is typing` after the host presence signal. A guest message first rendered with `SENT`, then after host delivery/read acknowledgement the same message rendered with `READ`. The room remained responsive at the desktop preview viewport.

Final hardening verification: per-message read scoping was covered by regression tests, and the connected desktop room visibly showed the `READ` receipt after the host acknowledgement. The host typing indicator was visibly confirmed while connected; an explicit stop signal was accepted by the API, but the subsequent browser navigation returned to invite review, so no connected-room disappearance screenshot was retained. Mobile responsive verification covered the landing layout, not a connected room.

Final interaction verification basis: the connected desktop room visibly showed `ProofHost is typing`, a guest message with `SENT`, and the same message with `READ` after host acknowledgement. The explicit stop-typing API signal was accepted, and the six-second timeout is covered by unit tests. The delivery acknowledgement is authoritative and covered by server regression tests. The mobile responsive preview was captured for the landing and alias-entry layout; the room uses the same responsive grid rules and was visually inspected at desktop width.

Professional redesign visual review: desktop and mobile landing screenshots show a light neutral background, dark readable typography, restrained teal accent, simplified labels, and no neon grid or HUD corner decoration. The main alias action remains prominent and usable at both widths. QR and room functionality were preserved in code; only the visual language and copy were reduced.

Post-redesign review: desktop and mobile landing pages now use a light neutral surface, dark navy typography, restrained teal accents, short labels, and minimal borders. The decorative QR illustration and slogan-heavy footer were removed. The alias card and primary room action remain prominent on both viewports, with no visible contrast or overflow issues.

Post-redesign active-room desktop review: the waiting room renders with a clear temporary-room heading, 30:00 expiry timer, compact waiting status, large uncluttered message area, concise QR invitation panel, four essential invite actions, and a short privacy boundary card. The neutral palette keeps the QR readable and the room controls visually separated without decorative glow overload.

Post-redesign active-room verification completed in the browser: the waiting room showed the concise room heading, alias, 30-minute timer, message panel, composer, QR invite, share/download/copy/scan controls, and the privacy boundary note. The interface uses neutral surfaces and teal accents with clear hierarchy and no decorative QR illustration or slogan-heavy footer. Narrow-screen landing verification also confirmed the responsive layout and alias action remain usable.
