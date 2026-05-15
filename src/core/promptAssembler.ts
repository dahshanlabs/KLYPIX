// Assembles enhanced field values into a natural language prompt
import type { TaskType } from './promptEnhancer';

const FORMAT_NAMES: Record<string, string> = {
  pptx: 'PowerPoint presentation (.pptx)',
  docx: 'Word document (.docx)',
  xlsx: 'Excel spreadsheet (.xlsx)',
  pdf: 'PDF document',
  png: 'PNG image(s)',
  csv: 'CSV file',
  json: 'JSON file',
  none: '',
};

export function assembleEnhancedPrompt(
  originalPrompt: string,
  taskType: TaskType,
  fieldValues: Record<string, any>,
): string {
  switch (taskType) {
    case 'chart':
      return assembleChart(originalPrompt, fieldValues);
    case 'analysis':
      return assembleAnalysis(originalPrompt, fieldValues);
    case 'data_processing':
      return assembleDataProcessing(originalPrompt, fieldValues);
    case 'document':
      return assembleDocument(originalPrompt, fieldValues);
    default:
      return assembleGeneral(originalPrompt, fieldValues);
  }
}

function assembleChart(original: string, v: Record<string, any>): string {
  const parts: string[] = [original];
  const specs: string[] = [];

  if (v.chart_type) specs.push(`Chart type: ${v.chart_type}`);
  if (v.chart_count && v.chart_count > 1) specs.push(`Create ${v.chart_count} charts`);
  if (v.data_focus && Array.isArray(v.data_focus) && v.data_focus.length > 0) {
    specs.push(`Focus on: ${v.data_focus.join(', ')}`);
  }
  if (v.output_format && v.output_format !== 'none') {
    specs.push(`Output as ${FORMAT_NAMES[v.output_format] || v.output_format}`);
  }

  if (specs.length > 0) {
    parts.push('\nSpecifications:');
    parts.push(specs.map(s => `- ${s}`).join('\n'));
  }

  parts.push('\nUse the data from the file currently open on screen.');
  return parts.join('\n');
}

function assembleAnalysis(original: string, v: Record<string, any>): string {
  const parts: string[] = [original];
  const specs: string[] = [];

  if (v.depth) specs.push(`Depth: ${v.depth === 'quick' ? 'quick summary' : v.depth === 'deep' ? 'deep dive with detailed breakdown' : 'standard analysis'}`);
  if (v.focus_areas && Array.isArray(v.focus_areas) && v.focus_areas.length > 0) {
    specs.push(`Focus areas: ${v.focus_areas.join(', ')}`);
  }
  if (v.sections && Array.isArray(v.sections) && v.sections.length > 0) {
    const sectionNames: Record<string, string> = {
      summary: 'Executive Summary', findings: 'Key Findings',
      recommendations: 'Recommendations', data_tables: 'Data Tables', charts: 'Charts',
    };
    specs.push(`Include sections: ${v.sections.map((s: string) => sectionNames[s] || s).join(', ')}`);
  }
  if (v.output_format && v.output_format !== 'none') {
    specs.push(`Output as ${FORMAT_NAMES[v.output_format] || v.output_format}`);
  }

  if (specs.length > 0) {
    parts.push('\nSpecifications:');
    parts.push(specs.map(s => `- ${s}`).join('\n'));
  }

  return parts.join('\n');
}

function assembleDataProcessing(original: string, v: Record<string, any>): string {
  const parts: string[] = [original];
  const specs: string[] = [];

  if (v.transformation) specs.push(`Operation: ${v.transformation}`);
  if (v.data_focus && Array.isArray(v.data_focus) && v.data_focus.length > 0) {
    specs.push(`Columns/fields: ${v.data_focus.join(', ')}`);
  }
  if (v.output_format && v.output_format !== 'none') {
    specs.push(`Output as ${FORMAT_NAMES[v.output_format] || v.output_format}`);
  }

  if (specs.length > 0) {
    parts.push('\nSpecifications:');
    parts.push(specs.map(s => `- ${s}`).join('\n'));
  }

  return parts.join('\n');
}

function assembleDocument(original: string, v: Record<string, any>): string {
  const parts: string[] = [original];
  const specs: string[] = [];

  if (v.doc_type) specs.push(`Document type: ${v.doc_type}`);
  if (v.tone) specs.push(`Tone: ${v.tone}`);
  if (v.output_format && v.output_format !== 'none') {
    specs.push(`Output as ${FORMAT_NAMES[v.output_format] || v.output_format}`);
  }

  if (specs.length > 0) {
    parts.push('\nSpecifications:');
    parts.push(specs.map(s => `- ${s}`).join('\n'));
  }

  return parts.join('\n');
}

function assembleGeneral(original: string, v: Record<string, any>): string {
  const parts: string[] = [original];

  if (v.additional_context && v.additional_context.trim()) {
    parts.push(v.additional_context.trim());
  }
  if (v.output_format && v.output_format !== 'none') {
    parts.push(`Output as ${FORMAT_NAMES[v.output_format] || v.output_format}.`);
  }

  return parts.join('\n');
}
