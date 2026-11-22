export interface KotlinPythonModule {
  id: string;
  filename: string;
  language: 'python' | 'kotlin';
  platform: string;
  moduleGroup: 'calendar-sync' | 'backend-auth' | 'statistics';
  summary: string;
  code: string;
}

export const KOTLIN_PYTHON_MODULES: KotlinPythonModule[] = [
  {
    id: 'py-nas-calendar-sync',
    filename: 'de_series_calendar_sync.py',
    language: 'python',
    platform: 'Raspberry Pi / Linux NAS (FastAPI)',
    moduleGroup: 'calendar-sync',
    summary:
      'Synchronisiert deutsche Serien-Neustarts (TVMaze DE, Streaming-Feeds) mit dem lokalen NAS-JSON-Cache und löst Favoriten-Benachrichtigungen aus.',
    code: `from datetime import date, datetime, timezone
import json
from pathlib import Path
from typing import Dict, List

CALENDAR_FILE = Path("/mnt/nas/entencenter/calendar_de.json")


def sync_de_releases(releases: List[Dict]) -> Dict:
    today = date.today().isoformat()
    upcoming = [r for r in releases if r.get("releaseDate", "") >= today]
    payload = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(upcoming),
        "releases": sorted(upcoming, key=lambda x: x.get("releaseDate", "")),
    }
    CALENDAR_FILE.parent.mkdir(parents=True, exist_ok=True)
    CALENDAR_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload
`,
  },
  {
    id: 'kt-nas-auth-client',
    filename: 'NasAuthClient.kt',
    language: 'kotlin',
    platform: 'Android TV & Mobile (Kotlin)',
    moduleGroup: 'backend-auth',
    summary:
      'Sichere Authentifizierung und Token-Verwaltung gegen das EntenCenter NAS-Backend im lokalen Heimnetzwerk.',
    code: `package de.entenmedia.entencenter.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

class NasAuthClient(private val baseUrl: String) {
    suspend fun verifyHealth(): Boolean = withContext(Dispatchers.IO) {
        val conn = (URL("$baseUrl/api/health").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 4000
            readTimeout = 4000
        }
        try {
            conn.responseCode in 200..299
        } finally {
            conn.disconnect()
        }
    }
}
`,
  },
  {
    id: 'py-watch-stats',
    filename: 'watch_statistics_aggregator.py',
    language: 'python',
    platform: 'Raspberry Pi / Linux NAS (Worker)',
    moduleGroup: 'statistics',
    summary:
      'Aggregiert Wiedergabezeiten, abgeschlossene Episoden und Lieblingsgenres pro NAS-Profil ohne Cloud-Abhängigkeit.',
    code: `from collections import Counter
from typing import Dict, List


def compute_profile_stats(history: List[Dict]) -> Dict:
    total_minutes = sum(int(item.get("watchedMinutes", 0)) for item in history)
    genres = Counter(item.get("genre", "Allgemein") for item in history)
    return {
        "totalWatchedMinutes": total_minutes,
        "completedTitles": sum(1 for i in history if i.get("completed")),
        "topGenres": genres.most_common(5),
    }
`,
  },
];
