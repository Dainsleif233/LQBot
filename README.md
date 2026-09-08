# qbot - Serverless QQ Official Bot (EdgeOne Edge Functions)

A QQ official bot service running on EdgeOne edge functions:

- Receives Webhook pushes from QQ official servers (group @-messages, private messages)
- Sends messages via QQ OpenAPI using fetch
- Persists data (permissions, etc.) with the KV database
- Built-in permission system (tiered) and command system (plugin-style registration)

Channel (Guild) scenarios are not considered.

## Directory layout

    qbot/
      edge-functions/            # only the public interface
        api/webhook.js        entry: POST /api/webhook
      src/                     # all internal modules (bundled by the edge build)
        lib/
          config.js           runtime config from env vars
          crypto.js           Webhook Ed25519 sign/verify (URL verify + event verify)
          tweetnacl.js         vendored pure-JS Ed25519 (edge runtime lacks WebCrypto Ed25519)
          qq.js               QQ OpenAPI client (token / send / group members)
          permissions.js      permission resolution (3>2>1>0, tiered)
          registry.js         command registration and parsing
          reply.js            reply by scene (group / private)
          handler.js          Webhook main logic (verify / dispatch / execute)
        commands/
          permission.js       /permission  permission management (level 3)
          openid.js           /openid      lookup openid by nickname (level 3, group only)
          test.js             /test        test command (level 0)
      .env.example
      package.json
      README.md

## Setup

1. Enable KV storage and bind a namespace
   - EdgeOne Makers console -> KV Storage -> apply -> create namespace.
   - Bind it to this project with variable name "my_kv" (accessed as the global "my_kv").

2. Configure environment variables
   - Copy .env.example to .env (local) or set them in the Makers console:
     APP_ID / APP_SECRET (QQ bot credentials), SUPER_ADMIN_OPENID (level-3 user openid), etc.

3. Local dev

    npm install -g edgeone
    PAGES_SOURCE=skills edgeone makers dev -n qbot
    # open http://127.0.0.1:8088/

4. Deploy

    PAGES_SOURCE=skills edgeone makers deploy -n qbot

5. Configure QQ Webhook
   - In QQ open platform "开发设置 -> 回调地址", set: https://<your-edge-domain>/api/webhook
   - The platform first sends op=13 URL verification. This service derives an Ed25519
     private key from APP_SECRET (or WEBHOOK_SECRET) and signs event_ts + plain_token,
     then returns it to pass verification automatically.

## Permission system

User levels (tiered; a higher level has all lower-level permissions):

    Level 3  Super admin      from env SUPER_ADMIN_OPENID
    Level 2  Global admin     set by super admin via /permission (stored in KV)
    Level 1  Group admin      default "scene value"; can be overridden via /permission
    Level 0  Normal user      default "scene value"; can be overridden via /permission

Resolution order: super admin (env, 3) -> explicit KV override (0-3) -> scene default.

- Private messages are treated as group admin (level 1).
- Group scene returns GROUP_SCENE_LEVEL by default (default 1). With CHECK_GROUP_ADMIN on,
  it calls the group member API to detect real group admins (role match -> 1, else 0).
- "Group admin / normal user are auto from scene, not persisted, override after setting"
  corresponds exactly to the scene-default + KV-override mechanism above.

## Command system

- Triggers: group @-bot messages, private messages.
- Format: /<command> [args] (args optional, multiple supported; aliases/description/scenes allowed).
- Command permission is checked by each handler with a tiered comparison.
- Feedback is auto-sent to the correct scene (group -> group, private -> private) using passive reply (event message id attached).

Built-in commands:
- /permission [<user_openid> [<int>]]  (group/private, level 3)
    - no arg:  return your current scene permission.
    - 1 arg:   return that user's current scene permission (incl. KV override).
    - 2 args:  set that user's permission to 0-3.
- /openid <nickname>  (group only, level 3): match by nickname in group member list, return openid.
- /test [args]  (group/private, level 0): echo original message, args, arg count, user openid,
  user permission, user nickname.

## Add a command

Create a module under src/commands/ exporting the fields below, then import it
into the commands array in src/lib/registry.js:

    import { LEVELS } from '../lib/permissions.js';
    export const name = 'hello';
    export const aliases = ['hi'];
    export const description = 'say hi';
    export const scenes = ['group', 'private'];
    export const minLevel = LEVELS.USER;
    export async function handler(ctx) {
      // ctx: { args, raw, original, scene, userOpenid, nick, level, reply, ... }
      await ctx.reply('hello, ' + (ctx.nick || 'friend'));
    }

## Known caveats (some official docs are not fully open yet; calibrate as needed)
- Group member API: the response shape of GET /v2/groups/{group_openid}/members (esp. role / nick
  fields) is not fully documented. Code is defensive; if fields differ in practice, adjust
  normalizeMembers in commands/openid.js and isGroupAdminRole in lib/permissions.js.
- Passive reply window: group 5 min, private 60 min; beyond that only active messages (monthly quota).
- Ed25519: Webhook signature relies on crypto.subtle Ed25519 support; modern V8 edge runtimes have it.
