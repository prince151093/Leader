# `?undeveloper @user` shortcut

This change adds a built-in prefix shortcut that removes the server role named `Developer` from the mentioned member.

- Usage: `?undeveloper @user`
- Requires the caller to have Manage Roles and pass the bot's existing `giverole` command access policy.
- Checks that LEADER can manage the Developer role and that the caller is not trying to manage a member with an equal/higher role (unless the caller owns the server).
- The Developer role must be named `Developer` (case-insensitive). LEADER needs Manage Roles and its highest role must be above Developer.

Replace `Leader-main/index.js` with the included file and restart/redeploy the bot.
