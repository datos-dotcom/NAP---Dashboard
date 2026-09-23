"""
Sincroniza una base SQLite guardada en Dropbox hacia una Google Sheet.
Crea (o sobrescribe) una pestaña "raw_<tabla>" por cada tabla de la base.

Variables de entorno requeridas (se configuran como Secrets en GitHub Actions):
  DROPBOX_APP_KEY
  DROPBOX_APP_SECRET
  DROPBOX_REFRESH_TOKEN
  DROPBOX_FILE_PATH            ej: /NAP/database.db
  GOOGLE_SERVICE_ACCOUNT_JSON  contenido completo del JSON de la cuenta de servicio
  SPREADSHEET_ID               ID de la Google Sheet destino (de la URL)
"""

import datetime
import json
import os
import sqlite3
import sys
import tempfile

import dropbox
import gspread
from google.oauth2.service_account import Credentials

# Tablas internas que no queremos volcar a Sheets
SKIP_TABLES = {
    "sqlite_sequence",
    "sqlite_stat1",
    "_prisma_migrations",
    "knex_migrations",
    "knex_migrations_lock",
}

# Tope de filas por tabla, para no chocar con límites de Sheets (10M celdas por doc)
MAX_ROWS_PER_TABLE = 30000


def env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"ERROR: falta la variable de entorno {name}", file=sys.stderr)
        sys.exit(1)
    return value


def download_db() -> str:
    app_key = env("DROPBOX_APP_KEY")
    app_secret = env("DROPBOX_APP_SECRET")
    refresh_token = env("DROPBOX_REFRESH_TOKEN")
    file_path = env("DROPBOX_FILE_PATH")

    dbx = dropbox.Dropbox(
        app_key=app_key,
        app_secret=app_secret,
        oauth2_refresh_token=refresh_token,
    )

    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    print(f"Descargando {file_path} de Dropbox...")
    dbx.files_download_to_file(tmp.name, file_path)
    print("Descarga OK")
    return tmp.name


def get_spreadsheet():
    creds_json = env("GOOGLE_SERVICE_ACCOUNT_JSON")
    spreadsheet_id = env("SPREADSHEET_ID")

    creds_info = json.loads(creds_json)
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_info(creds_info, scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open_by_key(spreadsheet_id)


def list_tables(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    return [row[0] for row in cur.fetchall() if row[0] not in SKIP_TABLES]


def sync_table(sh, conn: sqlite3.Connection, table_name: str):
    cur = conn.cursor()
    cur.execute(f'SELECT * FROM "{table_name}" LIMIT {MAX_ROWS_PER_TABLE}')
    rows = cur.fetchall()
    columns = [d[0] for d in cur.description]

    tab_name = f"raw_{table_name}"[:99]

    try:
        ws = sh.worksheet(tab_name)
        ws.clear()
    except gspread.WorksheetNotFound:
        ws = sh.add_worksheet(
            title=tab_name,
            rows=str(max(len(rows) + 10, 100)),
            cols=str(max(len(columns) + 2, 10)),
        )

    def clean(v):
        if v is None:
            return ""
        return v

    data = [columns] + [[clean(c) for c in row] for row in rows]
    ws.update("A1", data, value_input_option="RAW")
    print(f"  ✓ {table_name}: {len(rows)} filas -> pestaña '{tab_name}'")


def update_sync_meta(sh, tables_synced):
    try:
        meta = sh.worksheet("_sync_meta")
        meta.clear()
    except gspread.WorksheetNotFound:
        meta = sh.add_worksheet(title="_sync_meta", rows="20", cols="2")

    now = datetime.datetime.utcnow().isoformat() + "Z"
    rows = [
        ["ultima_sincronizacion_utc", now],
        ["tablas_sincronizadas", ", ".join(tables_synced)],
    ]
    meta.update("A1", rows, value_input_option="RAW")


def main():
    db_path = download_db()
    conn = sqlite3.connect(db_path)

    sh = get_spreadsheet()

    tables = list_tables(conn)
    print(f"Tablas encontradas en la base: {tables}")

    for table in tables:
        sync_table(sh, conn, table)

    update_sync_meta(sh, tables)

    conn.close()
    os.unlink(db_path)
    print("Sincronización completa.")


if __name__ == "__main__":
    main()
