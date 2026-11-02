import { Pressable, View } from "react-native";

import type { DailyTotals } from "@t3tools/shared/usageMerge";

import { buildChartDays, type UsageChartMetric } from "./usageChartData";
import { useProviderColors } from "./usageProviders";

export interface UsageDailyChartProps {
  readonly days: readonly string[];
  readonly daily: readonly DailyTotals[];
  readonly metric: UsageChartMetric;
  readonly height: number;
  readonly selectedDay: string | null;
  readonly onSelectDay: (day: string) => void;
}

export function UsageDailyChart({
  days,
  daily,
  metric,
  height,
  selectedDay,
  onSelectDay,
}: UsageDailyChartProps) {
  const colors = useProviderColors();
  const chartDays = buildChartDays(days, daily, metric);
  const max = chartDays.reduce((peak, day) => Math.max(peak, day.total), 0);

  return (
    <View style={{ height }} className="flex-row items-stretch gap-px">
      {chartDays.map((day) => (
        <Pressable
          key={day.day}
          accessibilityRole="button"
          accessibilityLabel={`Show usage for ${day.day}`}
          accessibilityState={{ selected: selectedDay === day.day }}
          onPress={() => onSelectDay(day.day)}
          className={`flex-1 justify-end ${selectedDay === day.day ? "bg-subtle" : ""}`}
        >
          <View
            style={{ height: max === 0 ? 0 : (day.total / max) * height }}
            className="flex-col-reverse overflow-hidden rounded-t-sm"
          >
            {day.values.map((entry) => (
              <View
                key={entry.provider}
                style={{
                  height: max === 0 ? 0 : (entry.value / max) * height,
                  backgroundColor: colors[entry.provider],
                }}
              />
            ))}
          </View>
        </Pressable>
      ))}
    </View>
  );
}
