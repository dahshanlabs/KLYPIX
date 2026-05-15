// Field definitions per task type for the Prompt Enhancer modal
import type { TaskType } from './promptEnhancer';

export type FieldType = 'chip_select' | 'multi_chip' | 'text' | 'number';

export interface EnhancerField {
  id: string;
  label: string;
  type: FieldType;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  defaultValue?: string | string[] | number;
  required?: boolean;
}

export interface TaskFieldSet {
  taskType: TaskType;
  title: string;
  subtitle: string;
  fields: EnhancerField[];
}

// ── Field sets per task type ─────────────────────────────────────────────────

export const TASK_FIELD_SETS: Record<TaskType, TaskFieldSet> = {
  chart: {
    taskType: 'chart',
    title: 'Chart Builder',
    subtitle: 'What kind of charts do you need?',
    fields: [
      {
        id: 'chart_type',
        label: 'Chart Type',
        type: 'chip_select',
        options: [
          { value: 'bar', label: 'Bar' },
          { value: 'line', label: 'Line' },
          { value: 'pie', label: 'Pie' },
          { value: 'scatter', label: 'Scatter' },
          { value: 'area', label: 'Area' },
          { value: 'combo', label: 'Combo' },
        ],
      },
      {
        id: 'data_focus',
        label: 'Data Focus',
        type: 'multi_chip',
        options: [], // populated from context
        placeholder: 'What columns/data to chart?',
      },
      {
        id: 'chart_count',
        label: 'Number of Charts',
        type: 'number',
        defaultValue: 1,
      },
      {
        id: 'output_format',
        label: 'Output Format',
        type: 'chip_select',
        options: [
          { value: 'pptx', label: 'PowerPoint' },
          { value: 'xlsx', label: 'Excel' },
          { value: 'pdf', label: 'PDF' },
          { value: 'png', label: 'Images' },
        ],
        defaultValue: 'pptx',
      },
    ],
  },

  analysis: {
    taskType: 'analysis',
    title: 'Analysis Builder',
    subtitle: 'How should the analysis be structured?',
    fields: [
      {
        id: 'depth',
        label: 'Depth',
        type: 'chip_select',
        options: [
          { value: 'quick', label: 'Quick Summary' },
          { value: 'standard', label: 'Standard' },
          { value: 'deep', label: 'Deep Dive' },
        ],
        defaultValue: 'standard',
      },
      {
        id: 'focus_areas',
        label: 'Focus On',
        type: 'multi_chip',
        options: [], // populated from context
        placeholder: 'Key areas to analyze',
      },
      {
        id: 'sections',
        label: 'Include Sections',
        type: 'multi_chip',
        options: [
          { value: 'summary', label: 'Executive Summary' },
          { value: 'findings', label: 'Key Findings' },
          { value: 'recommendations', label: 'Recommendations' },
          { value: 'data_tables', label: 'Data Tables' },
          { value: 'charts', label: 'Charts' },
        ],
        defaultValue: ['summary', 'findings'],
      },
      {
        id: 'output_format',
        label: 'Output Format',
        type: 'chip_select',
        options: [
          { value: 'docx', label: 'Word' },
          { value: 'pptx', label: 'PowerPoint' },
          { value: 'pdf', label: 'PDF' },
          { value: 'xlsx', label: 'Excel' },
        ],
        defaultValue: 'docx',
      },
    ],
  },

  data_processing: {
    taskType: 'data_processing',
    title: 'Data Processing',
    subtitle: 'What transformation do you need?',
    fields: [
      {
        id: 'transformation',
        label: 'Operation',
        type: 'chip_select',
        options: [
          { value: 'clean', label: 'Clean Data' },
          { value: 'merge', label: 'Merge Files' },
          { value: 'pivot', label: 'Pivot Table' },
          { value: 'filter', label: 'Filter Rows' },
          { value: 'aggregate', label: 'Aggregate' },
          { value: 'convert', label: 'Convert Format' },
        ],
      },
      {
        id: 'data_focus',
        label: 'Data Focus',
        type: 'multi_chip',
        options: [], // populated from context
        placeholder: 'Columns or fields to process',
      },
      {
        id: 'output_format',
        label: 'Output Format',
        type: 'chip_select',
        options: [
          { value: 'xlsx', label: 'Excel' },
          { value: 'csv', label: 'CSV' },
          { value: 'json', label: 'JSON' },
        ],
        defaultValue: 'xlsx',
      },
    ],
  },

  document: {
    taskType: 'document',
    title: 'Document Builder',
    subtitle: 'What kind of document?',
    fields: [
      {
        id: 'doc_type',
        label: 'Type',
        type: 'chip_select',
        options: [
          { value: 'report', label: 'Report' },
          { value: 'memo', label: 'Memo' },
          { value: 'proposal', label: 'Proposal' },
          { value: 'presentation', label: 'Presentation' },
          { value: 'letter', label: 'Letter' },
        ],
      },
      {
        id: 'tone',
        label: 'Tone',
        type: 'chip_select',
        options: [
          { value: 'formal', label: 'Formal' },
          { value: 'professional', label: 'Professional' },
          { value: 'casual', label: 'Casual' },
        ],
        defaultValue: 'professional',
      },
      {
        id: 'output_format',
        label: 'Output Format',
        type: 'chip_select',
        options: [
          { value: 'docx', label: 'Word' },
          { value: 'pptx', label: 'PowerPoint' },
          { value: 'pdf', label: 'PDF' },
        ],
        defaultValue: 'docx',
      },
    ],
  },

  general: {
    taskType: 'general',
    title: 'Enhance Prompt',
    subtitle: 'Add details for better results',
    fields: [
      {
        id: 'additional_context',
        label: 'Add Details',
        type: 'text',
        placeholder: 'Be specific about what you want...',
      },
      {
        id: 'output_format',
        label: 'Output Format',
        type: 'chip_select',
        options: [
          { value: 'none', label: 'No file' },
          { value: 'docx', label: 'Word' },
          { value: 'pptx', label: 'PowerPoint' },
          { value: 'xlsx', label: 'Excel' },
          { value: 'pdf', label: 'PDF' },
        ],
        defaultValue: 'none',
      },
    ],
  },
};
