# salarycosts Instagram auto-poster

Drop post folders into `queue/`. Twice a day (times in `schedule.json`) a free robot on GitHub posts the next folder to Instagram, in order, and moves it to `posted/`. You get **one email**: when the last post has gone out.

## What a post looks like
One folder = one Instagram carousel post:
```
queue/001-shocking-tax-facts/
  slide-01.jpg   <- the first picture people see (the hook)
  slide-02.jpg
  ...
  slide-08.jpg
  caption.txt    <- the text under the post
```
- Posts go out in **folder-name order** (`001-`, `002-`, ... `100-`). Use 3 digits so `010` sorts before `100`.
- Slides go out in **number order**: `slide-01.jpg` is always first.
- 2 to 10 slides per post, JPEG only, tall or square pictures (4:5 is perfect), caption up to 2,200 characters and 30 hashtags.
- A folder that breaks these rules is skipped and reported; it is never posted half-way.

## Everyday use
| I want to... | Do this |
|---|---|
| **Add posts** | On github.com open the repo, `queue/`, **Add file -> Upload files**, drag the new numbered folders in, **Commit**. (Or let Claude run `node social/export-queue.mjs`, then upload.) |
| **Change the times** | Edit `schedule.json`: `"timezone": "Europe/Berlin", "slots": ["12:30", "19:30"]`. A slot can also be `"Mon 19:30"` for one weekday. |
| **See what will go out next** | `Actions` tab -> **post to Instagram** -> **Run workflow** -> tick **dry run** -> it prints the next post, slide order and caption and posts nothing. |
| **Post the next one right now** | Same button, tick **force**. |
| **Pause everything** | `Actions` tab -> **post to Instagram** -> **... -> Disable workflow**. Enable it again to resume. |
| **See what was posted** | `posted.json` (date, folder, Instagram id) and the `posted/` folder. |
| **Change the order** | Rename the folders in `queue/` (the lowest number goes first). |

## Emails you will get
- **When the whole queue is published:** one issue/email "All posts are published". Nothing else, never after each post.
- **Only if something breaks** (for example the Instagram token expired): GitHub emails you that a run failed. Fix it, and it stops. This is rare and important, so keep it on.

## Refresh the token (about every 60 days, or never with a System User token)
The robot warns you by failing a run ~10 days before it expires if `FB_APP_ID` and `FB_APP_SECRET` secrets are set. To refresh: create a new long-lived token in the Meta developer app and paste it into the repo secret `IG_ACCESS_TOKEN` (Settings -> Secrets and variables -> Actions).

## One-time setup (Claude guides you through each click)
1. Instagram account type: **Business** or **Creator** (Instagram -> Settings -> Account type and tools).
2. Create a Facebook **Page** and link it to the Instagram account.
3. developers.facebook.com -> **Create app** (type Business) -> add the **Instagram** product -> generate an access token with `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`; note your **Instagram user id**.
4. GitHub: create a **public** repo `salarycosts-social`, upload this folder, then Settings -> Secrets and variables -> Actions -> add `IG_USER_ID` and `IG_ACCESS_TOKEN` (optional: `FB_APP_ID`, `FB_APP_SECRET`).
5. Settings -> Actions -> General -> Workflow permissions: **Read and write**.
6. Run a **dry run**, then **force** one real post as a test, then leave the schedule on.

## Good to know
- The repo is public because Instagram only accepts public image links. It contains only the finished marketing images and captions; the token is stored in GitHub Secrets, never in the files.
- Keep `posted/` small: delete old folders from `posted/` any time (the log in `posted.json` stays).
- GitHub switches off scheduled robots in a repo with no activity for 60 days. Every post commit counts as activity, and adding a batch does too.
- Tests: `npm test` (13 checks: schedule maths, validation, ordering, a fake Instagram, one-email rule).
