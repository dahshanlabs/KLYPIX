// Context-aware pre-filling for Prompt Enhancer fields
// Uses contextInsight (extracted from screenshot) to populate options and defaults

import type { EnhancerField } from './promptEnhancerFields';
import type { EnhancementAnalysis } from './promptEnhancer';

interface ContextInsight {
  seeing?: string;
  key_data?: Array<Record<string, any> | string>;
}

/**
 * Extract useful labels from contextInsight.key_data for field options.
 * These become clickable chips in the enhancer modal.
 */
function extractDataLabels(contextInsight: ContextInsight | null): Array<{ value: string; label: string }> {
  if (!contextInsight?.key_data || contextInsight.key_data.length === 0) return [];

  const labels: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();

  for (const entry of contextInsight.key_data) {
    if (typeof entry === 'string') {
      if (!seen.has(entry) && entry.length > 2 && entry.length < 50) {
        seen.add(entry);
        labels.push({ value: entry, label: entry });
      }
    } else if (typeof entry === 'object' && entry !== null) {
      for (const [key, value] of Object.entries(entry)) {
        const label = key.replace(/_/g, ' ');
        if (!seen.has(key) && label.length > 2 && label.length < 50) {
          seen.add(key);
          // Include the value in the label if it's short enough
          const valueStr = String(value);
          const displayLabel = valueStr.length < 20 ? `${label} (${valueStr})` : label;
          labels.push({ value: key, label: displayLabel });
        }
      }
    }
  }

  return labels.slice(0, 12); // Max 12 options to keep UI clean
}

/**
 * Pre-fill field values and populate dynamic options from context.
 * Returns: { fieldValues, updatedFields }
 */
export function getContextSuggestions(
  analysis: EnhancementAnalysis,
  contextInsight: ContextInsight | null,
  fields: EnhancerField[],
): { fieldValues: Record<string, any>; updatedFields: EnhancerField[] } {
  const fieldValues: Record<string, any> = {};
  const dataLabels = extractDataLabels(contextInsight);

  const updatedFields = fields.map(field => {
    const updated = { ...field };

    // Pre-fill from detected entities
    if (field.id === 'chart_type' && analysis.detectedEntities.chartType) {
      fieldValues[field.id] = analysis.detectedEntities.chartType;
    }
    if (field.id === 'chart_count' && analysis.detectedEntities.quantity) {
      fieldValues[field.id] = analysis.detectedEntities.quantity;
    }
    if (field.id === 'output_format' && analysis.detectedEntities.format) {
      fieldValues[field.id] = analysis.detectedEntities.format;
    }

    // Populate dynamic options from context data
    if ((field.id === 'data_focus' || field.id === 'focus_areas') && dataLabels.length > 0) {
      updated.options = dataLabels;
    }

    // Apply default values
    if (fieldValues[field.id] === undefined && field.defaultValue !== undefined) {
      fieldValues[field.id] = field.defaultValue;
    }

    return updated;
  });

  return { fieldValues, updatedFields };
}
