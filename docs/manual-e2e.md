# Manual flow test (M0 prototype)

The ROADMAP §5 M0 gate says: "先用範例資料驗證選專案、保存範圍、版本卡片、比較與回復確認". **Status: prototype ready, no designer sessions yet.** The gate passes only after real sessions with designers who have no Git experience (ROADMAP §11).

## The prototype

`spikes/m0/gui` is a clickable React prototype using example data. Nothing touches the disk. Run it either way:

```bash
cd spikes/m0/gui && corepack pnpm install && corepack pnpm dev
```

The Electron spike loads the same build (`spikes/m0/desktop`, see [`spikes/m0/README.md`](../spikes/m0/README.md)) and adds live Engine status under 設定與診斷.

The left rail, 「導覽」, lists the eight tasks below and marks each as done. The facilitator tools at its bottom simulate an edit in the designer's editor and reset the prototype for the next participant. The dashed 「原型示範」 box on the restore screen triggers the `PLAN_STALE` and `UNTRACKED_FILES` states.

Screens covered (M1 §4.1):
- 開始 / 最近專案, including a project whose folder is missing (「找不到來源資料夾」, relink without searching the disk)
- 保存範圍審查
- 版本歷史 cards with thumbnails and source badges
- 比較版本 (side-by-side previews, file list, escaped text diff)
- 回復到此版 (plan, protection, progress, and a result that appends history)
- 備份 / 匯入 to an empty folder
- 設定與診斷, where agent access is optional

Known gaps: all data is mock, so a reload resets it. Recovery-required, `SOURCE_BUSY`, disk-space and preview-failure demos are missing. IME text input and screen-reader use are untested.

## Session script (about 30 minutes per participant)

Recruit designers who make web prototypes, preferably with external agents, and have never used Git. Use a 1280×800 window. Read each task aloud, don't explain the UI, and ask the participant to think aloud.

| # | Task (say this) | Observe | Pass if |
|---|---|---|---|
| 1 | 「請開始使用，選一個設計資料夾或試用範例。」 | Which entry they pick | Reaches scope review unaided |
| 2 | 「在保存之前，告訴我哪些檔案會被保存、哪些不會，以及為什麼。」 | Do they find exclusions and the symlink block? | Explains `.env.local`/`node_modules` exclusion; resolves the symlink by 排除 |
| 3 | 「保存第一版。」 | Hesitation at 確認並保存第一版 | Baseline card appears |
| 4 | (Facilitator: 模擬在編輯器修改檔案) 「你在編輯器改了設計，回來保存，並取個名字。」 | Do they notice 「有 N 個檔案尚未保存」? | Named version saved |
| 5 | 「找到第一版，說說它和現在差在哪裡。」 | Thumbnails vs file list use | Opens compare; names a visual difference |
| 6 | 「把設計回到第一版。回到之前，你目前的修改會怎樣？」 | Do they read the protection note? | Explains that current work is kept as 回復前保護版本; confirms |
| 7 | 「回到剛剛被保護的那一版。」 | Understanding of appended history | Finds and restores the protection version |
| 8 | 「做一份歷史備份，再匯入到新的資料夾。」 | Understanding of 只包含已保存的版本 | Completes export and import to an empty folder |
| + | (Facilitator: PLAN_STALE demo) 「現在畫面說什麼？你會怎麼做？」 | Error comprehension | Clicks 重新檢查 without help |

After the tasks, ask for a 1–5 rating of confidence that "nothing I made will be lost". Then ask which words were unclear, including 保存範圍, 回復前保護版本 and 快取.

## Record per session

Date, participant profile, and for each task: completed (yes / with help / no), time, and verbatim confusion. Also record any moment they wanted a terminal or Git knowledge (should be zero), and suggested copy changes. Summarize the findings here and feed copy changes back into M1-04, M1-05 and M1-07.

| Session | Date | Profile | Tasks unaided (of 8) | Confidence (1–5) | Top issue |
|---|---|---|---|---|---|
| — | — | — | — | — | — |
