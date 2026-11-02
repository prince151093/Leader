# Leader VC Announcement feature

## Dashboard
Open the connected Leader dashboard and select **VC Announcements**.

- Enable or disable announcements.
- Select one or more server roles (`@everyone` is excluded).
- Each selected role has its own MP3, WAV, or OGG upload, preview, replace, and remove controls.
- Audio files are saved independently per role (maximum 10 MB each).
- If a member has multiple selected roles with audio configured, the highest-position matching role is used.

When a non-bot member joins a voice channel or moves directly from one voice channel to another, Leader joins the destination channel, plays the matching role's audio, and disconnects. Leaving a voice channel does not trigger an announcement. Only one announcement plays at a time per server.

## Deployment requirements
- Deploy the updated `index.js` and `LEADER-dashboard-v4-connected.html` together.
- Enable the Discord **Guild Voice States** intent and ensure Leader has **Connect** and **Speak** permissions in the target voice channels.
- Audio is stored at `assets/vc-announcements/` and settings at `vc-announcement-config.json` on the bot service filesystem. On Render or another host with an ephemeral filesystem, attach persistent storage or uploaded audio/settings may be lost after redeploy/restart.
- Keep `DASHBOARD_API_KEY` configured as before. The API route uses the same authenticated dashboard API.

## Runtime notes
The voice feature uses `@discordjs/voice`, `@discordjs/opus`, `libsodium-wrappers`, and `ffmpeg-static`. Missing audio files or voice permissions are logged without crashing the bot.
