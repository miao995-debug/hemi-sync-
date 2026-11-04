# 賽博雷音

用骨傳導耳機合成「念誦口型」的聲音：4 Hz 雙耳節拍在腦中繞，音色像音叉一樣找顱內的共振點。個人體驗用。

- **App**：https://miao995-debug.github.io/hemi-sync-/app/
- 規格與邊界條件：[docs/SPEC.md](docs/SPEC.md)
- 背景播放測試頁（開發前驗證用）：[spike/bg-audio/](spike/bg-audio/)

## 目錄

| 路徑 | 內容 |
|---|---|
| `app/` | 正式版（純前端，GitHub Pages 直接提供） |
| `app/voice.js` | 口型 → 共振峰、聲道響應（介面與合成共用） |
| `app/engine.js` | 合成引擎（AudioWorklet，加法合成，右耳整組平移差頻） |
| `app/app.js` | 介面 |
| `docs/` | 規格書 |
| `spike/` | 開發前的可行性測試 |

## 本機開發

```bash
py -m http.server 8765 --bind 127.0.0.1
```

開 http://localhost:8765/app/（AudioWorklet 需要 https 或 localhost）。

## 發布

推送到 `main` 即自動更新 GitHub Pages。**每次發布都要把版本號（`?v=`）一起改**：`app/index.html`、`app/app.js`（含 `VERSION`）、`app/engine.js`，否則手機可能用到快取的舊檔。
