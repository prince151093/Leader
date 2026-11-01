# Leader VC Announcement feature

## Dashboard
Open the connected Leader dashboard and select **VC Announcements**.

- Enable or disable the feature.
- Select one or more server roles (the `@everyone` role is excluded).
- Upload or replace an MP3, WAV, or OGG announcement (up to 10 MB).
- Preview the selected local audio before saving.
- Remove the saved audio if required.

When a non-bot member joins a voice channel from outside voice and has at least one selected role, Leader joins that voice channel, plays the saved audio, and disconnects. Channel-to-channel moves and role changes do not trigger playback. Only one announcement plays at a time per server.

## Deployment requirements
- Install dependencies from the updated `package.json` during deployment.
- Enable the Discord **Guild Voice States** intent (already requested by this bot) and ensure Leader has **Connect** and **Speak** permissions in the target voice channels.
- The audio is stored at `assets/vc-announcements/` and settings are stored in `vc-announcement-config.json` on the bot service filesystem. On Render or another host with an ephemeral filesystem, attach a persistent disk and mount it at the service project directory (or migrate these files to persistent object storage) or uploaded audio/settings may be lost after redeploy/restart.
- Keep `DASHBOARD_API_KEY` configured as before. The new API route uses the same authenticated dashboard API.

## Runtime notes
The voice feature uses `@discordjs/voice`, `@discordjs/opus`, `libsodium-wrappers`, and `ffmpeg-static` to encode and play the uploaded audio. If the bot lacks voice permissions or the audio file is missing/unreadable, it logs the issue and continues running without crashing.
