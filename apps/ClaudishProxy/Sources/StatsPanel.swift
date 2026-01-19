import SwiftUI

// MARK: - Components

struct DropdownSelector: View {
    @Binding var selection: StatsManager.StatsPeriod
    let options: [StatsManager.StatsPeriod]

    var body: some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button(option.rawValue) {
                    selection = option
                }
            }
        } label: {
            HStack(spacing: 8) {
                Text(selection.rawValue)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.themeText)

                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(.themeTextMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.themeHover)
            .cornerRadius(6)
        }
        .menuStyle(BorderlessButtonMenuStyle())
    }
}

struct DataTableRow: View {
    let date: String
    let model: String
    let tokens: String
    let cost: String

    var body: some View {
        HStack(spacing: 16) {
            Text(date)
                .font(.system(size: 13))
                .foregroundColor(.themeTextMuted)
                .frame(width: 80, alignment: .leading)

            Text(model)
                .font(.system(size: 13))
                .foregroundColor(.themeText)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(tokens)
                .font(.system(size: 13).monospacedDigit())
                .foregroundColor(.themeText)
                .frame(width: 70, alignment: .trailing)

            Text(cost)
                .font(.system(size: 13).monospacedDigit())
                .foregroundColor(.themeText)
                .frame(width: 70, alignment: .trailing)
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Main View

struct StatsPanel: View {
    @ObservedObject var statsManager: StatsManager

    private var totalTokens: Int {
        statsManager.periodStats.inputTokens + statsManager.periodStats.outputTokens
    }

    private var formattedActivity: [(id: UUID, date: String, model: String, tokens: String, cost: String)] {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "MMM d"

        return statsManager.recentActivity.map { stat in
            let tokens = stat.inputTokens + stat.outputTokens
            return (
                id: stat.id,
                date: dateFormatter.string(from: stat.timestamp),
                model: formatModelName(stat.targetModel),
                tokens: formatNumber(tokens),
                cost: "$0.00" // Cost calculation would need pricing data
            )
        }
    }

    var body: some View {
        ThemeCard {
            VStack(alignment: .leading, spacing: 16) {
                // Header with time range
                HStack {
                    Text("USAGE STATS")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(1.0)
                        .foregroundColor(.themeTextMuted)

                    Spacer()

                    DropdownSelector(
                        selection: Binding(
                            get: { statsManager.selectedPeriod },
                            set: { statsManager.setPeriod($0) }
                        ),
                        options: StatsManager.StatsPeriod.allCases
                    )
                }

                // Stats summary
                HStack(spacing: 24) {
                    StatBox(
                        label: "Requests",
                        value: "\(statsManager.periodStats.requests)",
                        icon: "arrow.up.arrow.down"
                    )

                    StatBox(
                        label: "Tokens",
                        value: formatNumber(totalTokens),
                        icon: "textformat.123"
                    )

                    StatBox(
                        label: "Today",
                        value: "\(statsManager.todayStats.requests)",
                        icon: "calendar"
                    )
                }

                // Dashed divider
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundColor(.themeBorder)
                    .frame(height: 1)

                // Recent activity table
                VStack(alignment: .leading, spacing: 10) {
                    Text("RECENT ACTIVITY")
                        .font(.system(size: 11, weight: .semibold))
                        .textCase(.uppercase)
                        .tracking(1.0)
                        .foregroundColor(.themeTextMuted)

                    if formattedActivity.isEmpty {
                        HStack {
                            Spacer()
                            VStack(spacing: 8) {
                                Image(systemName: "tray")
                                    .font(.system(size: 24))
                                    .foregroundColor(.themeTextMuted)
                                Text("No activity yet")
                                    .font(.system(size: 13))
                                    .foregroundColor(.themeTextMuted)
                            }
                            .padding(.vertical, 20)
                            Spacer()
                        }
                    } else {
                        // Table header
                        HStack(spacing: 16) {
                            Text("DATE")
                                .frame(width: 80, alignment: .leading)
                            Text("MODEL")
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text("TOKENS")
                                .frame(width: 70, alignment: .trailing)
                            Text("COST")
                                .frame(width: 70, alignment: .trailing)
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.themeTextMuted)

                        // Table rows
                        ForEach(formattedActivity, id: \.id) { activity in
                            DataTableRow(
                                date: activity.date,
                                model: activity.model,
                                tokens: activity.tokens,
                                cost: activity.cost
                            )
                        }
                    }
                }

                // Footer
                HStack {
                    Button(action: { statsManager.refreshStats() }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13))
                    }
                    .buttonStyle(PlainButtonStyle())
                    .foregroundColor(.themeTextMuted)

                    Text(statsManager.getDatabaseSize())
                        .font(.system(size: 11))
                        .foregroundColor(.themeTextSubtle)

                    Spacer()

                    Button(action: { statsManager.clearStats() }) {
                        Text("Clear")
                            .font(.system(size: 12))
                            .foregroundColor(.themeDestructive)
                    }
                    .buttonStyle(PlainButtonStyle())
                }
            }
        }
        .frame(maxWidth: 600)
    }

    // MARK: - Helpers

    private func formatNumber(_ num: Int) -> String {
        if num >= 1_000_000 {
            return String(format: "%.1fM", Double(num) / 1_000_000)
        } else if num >= 1_000 {
            return String(format: "%.1fK", Double(num) / 1_000)
        }
        return "\(num)"
    }

    private func formatModelName(_ model: String) -> String {
        // Shorten common model names
        if model.contains("/") {
            return model.components(separatedBy: "/").last ?? model
        }
        if model.hasPrefix("claude-") {
            return model.replacingOccurrences(of: "claude-", with: "")
        }
        return model
    }
}

// MARK: - Stat Box Component

struct StatBox: View {
    let label: String
    let value: String
    let icon: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                Text(label.uppercased())
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundColor(.themeTextMuted)

            Text(value)
                .font(.system(size: 20, weight: .bold).monospacedDigit())
                .foregroundColor(.themeText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
