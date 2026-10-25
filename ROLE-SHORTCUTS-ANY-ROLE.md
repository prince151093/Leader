# VR GAMERS — Role Shortcuts for Any Role

## What changed
- The Role Shortcuts dashboard now lets you choose **Give role** or **Remove role**.
- Choose any role LEADER can manage, set a shortcut name, and save it to the bot.
- Existing saved shortcuts without an action remain **Give role** shortcuts for backward compatibility.
- Examples:
  - `?member @user` — give Member
  - `?unmember @user` — remove Member
  - `?vip @user` — give VIP
  - `?unvip @user` — remove VIP
  - `?undeveloper @user` — existing built-in Developer removal command

## Install
1. Replace `Leader-main/index.js` with the included file and deploy/restart the bot.
2. Replace the hosted dashboard HTML with `LEADER-dashboard-v4-connected.html`.
3. Open **Role Shortcuts**, choose the action, role and shortcut name, click **Add shortcut**, then **Save shortcuts to bot**.

## Permissions and limitations
- The person using the command needs Discord **Manage Roles** and must pass the bot's existing command access rules.
- LEADER needs **Manage Roles**, and its highest role must be above the selected role.
- The caller cannot manage another member whose highest role is equal to or higher than theirs (unless they own the server).
- Shortcut names cannot conflict with built-in commands. Use names such as `unmember`, `unvip`, or `removehelper` for remove-role actions.
