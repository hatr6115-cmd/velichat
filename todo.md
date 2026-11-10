# Project TODO

- [x] Establish the alias-first temporary chat domain model
- [x] Build the cyberpunk landing page with responsive layout and HUD framing
- [x] Add alias validation with no identifying information requirements
- [x] Keep rooms available without an automatic timer until logout or closure
- [x] Restore the same room session after a page refresh
- [x] Keep the session through temporary network loss and reconnect automatically
- [x] Allow either participant to end a room early
- [x] Generate temporary QR invitations
- [x] Add share, download-QR, and copy-link actions
- [x] Add invite review screen showing the host alias
- [x] Allow one recipient to join with a chosen alias
- [x] Enforce the two-participant room limit
- [x] Add room-only temporary messaging
- [x] Show clear ended, invalid, and full-room states
- [x] Disclose that Android blocks OS capture while browsers and external cameras cannot be guaranteed
- [x] Keep messages out of persistent application tables
- [x] Add unit tests for aliases, invite payloads, room creation, joining, messaging, and teardown
- [x] Verify desktop and mobile responsive flows
- [x] Run type checking, tests, and production build
- [x] Capture visual verification screenshots
- [x] Ping the Render health endpoint on app visits and keep the active service warm
- [x] Add a retrying GitHub Actions Render keep-alive check every 5 minutes

## Ephemeral interaction signals

- [x] Add ephemeral per-room typing state with automatic timeout
- [x] Add live typing indicator UI for the other alias
- [x] Add ephemeral per-message read status without persistent message storage
- [x] Mark incoming messages read when they are visible in the chat panel
- [x] Render clear sent, delivered, and read receipt states
- [x] Add unit coverage for typing state, timeout, read updates, and teardown cleanup
- [x] Verify typing and read receipts in the responsive room UI

## Follow-up hardening discovered during verification

- [x] Mark incoming messages read only when they are visible in the chat panel and the tab is active
- [x] Add authoritative per-message delivery acknowledgement before showing DELIVERED
- [x] Browser-verify host typing appearance and disappearance in a connected room
- [x] Browser-verify sent, delivered, and read transitions in a connected room
- [x] Browser-verify the interaction states at a narrow responsive viewport

## Final interaction verification gaps

- [x] Observe only unread incoming messages and mark only intersecting messages as read
- [x] Browser-test typing indicator disappearance after the six-second timeout or explicit stop signal
- [x] Optionally capture the intermediate DELIVERED state in browser verification

## Read visibility hardening

- [x] Scope read observation to the scrollable chat message-list container
- [x] Verify an off-screen incoming message is not marked read until scrolled into view

## Professional interface refinement

- [x] Reduce dashboard and room copy to essential labels and instructions
- [x] Replace the multi-color cyberpunk palette with a restrained professional palette
- [x] Remove decorative HUD fragments and unnecessary promotional wording
- [x] Preserve clear QR, alias, room, and privacy controls
- [x] Verify typography, contrast, spacing, and responsive usability after simplification

## Final professional polish

- [x] Remove residual promotional footer slogans and decorative QR illustration
- [x] Verify the simplified connected room layout and QR panel on desktop and mobile
- [x] Record post-redesign active-room visual findings

## Active-room visual verification

- [x] Browser-verify the simplified active room on desktop, including room status, message list, composer, privacy note, and QR panel
- [x] Browser-verify the simplified active room at a narrow mobile viewport
- [x] Record post-redesign active-room findings for desktop and mobile

## Ephemeral media

- [x] Add in-memory voice-note, photo, and video items with size and MIME validation
- [x] Add voice-note recording and sending controls
- [x] Allow recipients to play voice notes once, then consume the media payload
- [x] Add view-once photo and video selection/sending controls
- [x] Allow recipients to open view-once photos and videos once, then consume the media payload
- [x] Remove consumed media payloads and clear room media on teardown
- [x] Disclose that Android blocks OS capture while browser capture cannot be guaranteed
- [x] Add unit tests for media validation, one-play, one-view, and room teardown
- [ ] Visually verify voice, photo, and video controls on desktop and mobile layouts

## Source archive

- [x] Create a lightweight ZIP of the current VeilChat source, tests, documentation, roadmap, and verification notes
- [x] Exclude node_modules, dist, caches, and runtime logs from the archive
- [x] Inspect the archive contents before delivery

## Archive packaging follow-up

- [ ] Explicitly exclude cache directories and files, then confirm they are absent from the ZIP
