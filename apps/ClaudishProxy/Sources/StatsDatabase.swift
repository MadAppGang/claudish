import Foundation
import SQLite3

/// SQLite database manager for persistent stats storage
/// Location: ~/Library/Application Support/ClaudishProxy/stats.db
final class StatsDatabase {
    static let shared = StatsDatabase()

    private var db: OpaquePointer?
    private let dbPath: String

    private init() {
        // Create Application Support directory path
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let appDir = appSupport.appendingPathComponent("ClaudishProxy", isDirectory: true)

        // Ensure directory exists
        try? FileManager.default.createDirectory(at: appDir, withIntermediateDirectories: true)

        dbPath = appDir.appendingPathComponent("stats.db").path
        print("[StatsDatabase] Database path: \(dbPath)")

        openDatabase()
        createTables()
    }

    deinit {
        sqlite3_close(db)
    }

    // MARK: - Database Setup

    private func openDatabase() {
        if sqlite3_open(dbPath, &db) != SQLITE_OK {
            print("[StatsDatabase] Error opening database: \(errorMessage)")
        }
    }

    private func createTables() {
        let createRequestsTable = """
            CREATE TABLE IF NOT EXISTS requests (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                source_model TEXT NOT NULL,
                target_model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                success INTEGER NOT NULL,
                app_name TEXT,
                cost REAL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_requests_target_model ON requests(target_model);
        """

        let createDailyStatsTable = """
            CREATE TABLE IF NOT EXISTS daily_stats (
                date TEXT PRIMARY KEY,
                total_requests INTEGER DEFAULT 0,
                total_input_tokens INTEGER DEFAULT 0,
                total_output_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0,
                models_used TEXT
            );
        """

        executeSQL(createRequestsTable)
        executeSQL(createDailyStatsTable)
    }

    // MARK: - Request Recording

    /// Record a new request
    func recordRequest(_ stat: RequestStat, appName: String? = nil, cost: Double = 0) {
        let sql = """
            INSERT OR REPLACE INTO requests
            (id, timestamp, source_model, target_model, input_tokens, output_tokens, duration_ms, success, app_name, cost)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[StatsDatabase] Error preparing insert: \(errorMessage)")
            return
        }
        defer { sqlite3_finalize(stmt) }

        let dateFormatter = ISO8601DateFormatter()
        let timestampStr = dateFormatter.string(from: stat.timestamp)

        sqlite3_bind_text(stmt, 1, stat.id.uuidString, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, timestampStr, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 3, stat.sourceModel, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 4, stat.targetModel, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 5, Int32(stat.inputTokens))
        sqlite3_bind_int(stmt, 6, Int32(stat.outputTokens))
        sqlite3_bind_int(stmt, 7, Int32(stat.durationMs))
        sqlite3_bind_int(stmt, 8, stat.success ? 1 : 0)
        if let app = appName {
            sqlite3_bind_text(stmt, 9, app, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(stmt, 9)
        }
        sqlite3_bind_double(stmt, 10, cost)

        if sqlite3_step(stmt) != SQLITE_DONE {
            print("[StatsDatabase] Error inserting request: \(errorMessage)")
        }

        // Update daily stats
        updateDailyStats(date: stat.timestamp, inputTokens: stat.inputTokens, outputTokens: stat.outputTokens, cost: cost, model: stat.targetModel)
    }

    private func updateDailyStats(date: Date, inputTokens: Int, outputTokens: Int, cost: Double, model: String) {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let dateStr = dateFormatter.string(from: date)

        // Upsert daily stats
        let sql = """
            INSERT INTO daily_stats (date, total_requests, total_input_tokens, total_output_tokens, total_cost, models_used)
            VALUES (?, 1, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                total_requests = total_requests + 1,
                total_input_tokens = total_input_tokens + excluded.total_input_tokens,
                total_output_tokens = total_output_tokens + excluded.total_output_tokens,
                total_cost = total_cost + excluded.total_cost,
                models_used = CASE
                    WHEN models_used NOT LIKE '%' || excluded.models_used || '%'
                    THEN models_used || ',' || excluded.models_used
                    ELSE models_used
                END;
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[StatsDatabase] Error preparing daily stats update: \(errorMessage)")
            return
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, dateStr, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(stmt, 2, Int32(inputTokens))
        sqlite3_bind_int(stmt, 3, Int32(outputTokens))
        sqlite3_bind_double(stmt, 4, cost)
        sqlite3_bind_text(stmt, 5, model, -1, SQLITE_TRANSIENT)

        if sqlite3_step(stmt) != SQLITE_DONE {
            print("[StatsDatabase] Error updating daily stats: \(errorMessage)")
        }
    }

    // MARK: - Queries

    /// Get recent requests (most recent first)
    func getRecentRequests(limit: Int = 100) -> [RequestStat] {
        let sql = """
            SELECT id, timestamp, source_model, target_model, input_tokens, output_tokens, duration_ms, success
            FROM requests
            ORDER BY timestamp DESC
            LIMIT ?;
        """

        var results: [RequestStat] = []
        var stmt: OpaquePointer?

        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[StatsDatabase] Error preparing select: \(errorMessage)")
            return results
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int(stmt, 1, Int32(limit))

        let dateFormatter = ISO8601DateFormatter()

        while sqlite3_step(stmt) == SQLITE_ROW {
            let idStr = String(cString: sqlite3_column_text(stmt, 0))
            let timestampStr = String(cString: sqlite3_column_text(stmt, 1))
            let sourceModel = String(cString: sqlite3_column_text(stmt, 2))
            let targetModel = String(cString: sqlite3_column_text(stmt, 3))
            let inputTokens = Int(sqlite3_column_int(stmt, 4))
            let outputTokens = Int(sqlite3_column_int(stmt, 5))
            let durationMs = Int(sqlite3_column_int(stmt, 6))
            let success = sqlite3_column_int(stmt, 7) == 1

            if let id = UUID(uuidString: idStr),
               let timestamp = dateFormatter.date(from: timestampStr) {
                let stat = RequestStat(
                    id: id,
                    timestamp: timestamp,
                    sourceModel: sourceModel,
                    targetModel: targetModel,
                    inputTokens: inputTokens,
                    outputTokens: outputTokens,
                    durationMs: durationMs,
                    success: success
                )
                results.append(stat)
            }
        }

        return results
    }

    /// Get total stats for a date range
    func getStats(from startDate: Date, to endDate: Date) -> (requests: Int, inputTokens: Int, outputTokens: Int, cost: Double) {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"

        let sql = """
            SELECT
                COALESCE(SUM(total_requests), 0),
                COALESCE(SUM(total_input_tokens), 0),
                COALESCE(SUM(total_output_tokens), 0),
                COALESCE(SUM(total_cost), 0)
            FROM daily_stats
            WHERE date BETWEEN ? AND ?;
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[StatsDatabase] Error preparing stats query: \(errorMessage)")
            return (0, 0, 0, 0)
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, dateFormatter.string(from: startDate), -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, dateFormatter.string(from: endDate), -1, SQLITE_TRANSIENT)

        if sqlite3_step(stmt) == SQLITE_ROW {
            return (
                requests: Int(sqlite3_column_int(stmt, 0)),
                inputTokens: Int(sqlite3_column_int(stmt, 1)),
                outputTokens: Int(sqlite3_column_int(stmt, 2)),
                cost: sqlite3_column_double(stmt, 3)
            )
        }

        return (0, 0, 0, 0)
    }

    /// Get stats for today
    func getTodayStats() -> (requests: Int, inputTokens: Int, outputTokens: Int, cost: Double) {
        let today = Calendar.current.startOfDay(for: Date())
        return getStats(from: today, to: Date())
    }

    /// Get stats for last N days
    func getStatsForLastDays(_ days: Int) -> (requests: Int, inputTokens: Int, outputTokens: Int, cost: Double) {
        let endDate = Date()
        let startDate = Calendar.current.date(byAdding: .day, value: -days, to: endDate) ?? endDate
        return getStats(from: startDate, to: endDate)
    }

    /// Get all-time totals
    func getAllTimeStats() -> (requests: Int, inputTokens: Int, outputTokens: Int, cost: Double) {
        let sql = """
            SELECT
                COALESCE(SUM(total_requests), 0),
                COALESCE(SUM(total_input_tokens), 0),
                COALESCE(SUM(total_output_tokens), 0),
                COALESCE(SUM(total_cost), 0)
            FROM daily_stats;
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[StatsDatabase] Error preparing all-time stats query: \(errorMessage)")
            return (0, 0, 0, 0)
        }
        defer { sqlite3_finalize(stmt) }

        if sqlite3_step(stmt) == SQLITE_ROW {
            return (
                requests: Int(sqlite3_column_int(stmt, 0)),
                inputTokens: Int(sqlite3_column_int(stmt, 1)),
                outputTokens: Int(sqlite3_column_int(stmt, 2)),
                cost: sqlite3_column_double(stmt, 3)
            )
        }

        return (0, 0, 0, 0)
    }

    /// Get model usage breakdown
    func getModelUsage(days: Int? = nil) -> [(model: String, count: Int, tokens: Int)] {
        var sql = """
            SELECT target_model, COUNT(*) as count, SUM(input_tokens + output_tokens) as tokens
            FROM requests
        """

        if let days = days {
            let dateFormatter = ISO8601DateFormatter()
            let startDate = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
            sql += " WHERE timestamp >= '\(dateFormatter.string(from: startDate))'"
        }

        sql += " GROUP BY target_model ORDER BY count DESC LIMIT 10;"

        var results: [(model: String, count: Int, tokens: Int)] = []
        var stmt: OpaquePointer?

        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            print("[StatsDatabase] Error preparing model usage query: \(errorMessage)")
            return results
        }
        defer { sqlite3_finalize(stmt) }

        while sqlite3_step(stmt) == SQLITE_ROW {
            let model = String(cString: sqlite3_column_text(stmt, 0))
            let count = Int(sqlite3_column_int(stmt, 1))
            let tokens = Int(sqlite3_column_int(stmt, 2))
            results.append((model: model, count: count, tokens: tokens))
        }

        return results
    }

    // MARK: - Maintenance

    /// Clear all stats data
    func clearAllStats() {
        executeSQL("DELETE FROM requests;")
        executeSQL("DELETE FROM daily_stats;")
        print("[StatsDatabase] All stats cleared")
    }

    /// Vacuum database to reclaim space
    func vacuum() {
        executeSQL("VACUUM;")
    }

    /// Get database file size in bytes
    func getDatabaseSize() -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: dbPath),
              let size = attrs[.size] as? Int64 else {
            return 0
        }
        return size
    }

    // MARK: - Helpers

    private func executeSQL(_ sql: String) {
        var errMsg: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &errMsg) != SQLITE_OK {
            if let errMsg = errMsg {
                print("[StatsDatabase] SQL error: \(String(cString: errMsg))")
                sqlite3_free(errMsg)
            }
        }
    }

    private var errorMessage: String {
        if let errMsg = sqlite3_errmsg(db) {
            return String(cString: errMsg)
        }
        return "Unknown error"
    }
}

// MARK: - SQLITE_TRANSIENT helper
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
