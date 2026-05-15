// ============================================================
// ConfirmationModal.stub.tsx  —  Project Eye / ALT+Space
// Phase 3.1 STUB → Full version in Phase 3.3
// ============================================================
//
// This is a minimal working stub for Phase 3.1.
// It shows the intent preview and Confirm/Cancel buttons.
// Phase 3.3 will replace this with the full modal including
// diff view, undo countdown, and accessibility keyboard nav.
// ============================================================

import React from 'react';
import { Intent } from '../engine/intentTypes';

interface ConfirmationModalProps {
  intent:    Intent;
  onConfirm: () => void;
  onCancel:  () => void;
}

// Icon mapping for intent types
const INTENT_ICONS: Record<string, string> = {
  file_save:         '💾',
  file_rename:       '✏️',
  file_move:         '📁',
  file_create:       '📄',
  file_delete:       '🗑️',
  clipboard_save:    '📋',
  clipboard_copy:    '📋',
  browser_navigate:  '🌐',
  browser_fill:      '⌨️',
  browser_click:     '🖱️',
  browser_scroll:    '↕️',
  system_open:       '🚀',
  system_type:       '⌨️',
  system_click:      '🖱️',
  system_screenshot: '📸',
};

// Colour accent by risk level
const INTENT_COLOR: Record<string, { border: string; bg: string; badge: string }> = {
  file_delete: { border: '#DC2626', bg: '#FFF5F5', badge: '#DC2626' },
  file_move:   { border: '#EA580C', bg: '#FFFBF0', badge: '#EA580C' },
  file_rename: { border: '#EA580C', bg: '#FFFBF0', badge: '#EA580C' },
  file_save:   { border: '#1A4A7A', bg: '#F0F6FF', badge: '#1A4A7A' },
};

const DEFAULT_STYLE = { border: '#1A4A7A', bg: '#F0F6FF', badge: '#1A4A7A' };

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  intent,
  onConfirm,
  onCancel,
}) => {
  const style = INTENT_COLOR[intent.type] ?? DEFAULT_STYLE;
  const icon  = INTENT_ICONS[intent.type] ?? '⚡';

  // Keyboard handler — Enter to confirm, Escape to cancel
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter')  onConfirm();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div
      style={overlayStyle}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      autoFocus
    >
      <div style={{ ...modalStyle, borderLeft: `4px solid ${style.border}`, background: style.bg }}>

        {/* ── Header ────────────────────────────── */}
        <div style={headerStyle}>
          <span style={iconStyle}>{icon}</span>
          <div>
            <div style={titleStyle}>AI Action Ready</div>
            <div style={{ ...badgeStyle, background: style.badge }}>
              {intent.type.replace('_', ' ').toUpperCase()}
            </div>
          </div>
          <button style={closeStyle} onClick={onCancel}>✕</button>
        </div>

        {/* ── Preview ───────────────────────────── */}
        <div style={previewBoxStyle}>
          <div style={previewLabelStyle}>What will happen:</div>
          <div style={previewTextStyle}>{intent.previewDescription}</div>
        </div>

        {/* ── Parameters (collapsed key-values) ─── */}
        {Object.keys(intent.parameters).length > 0 && (
          <div style={paramsStyle}>
            {Object.entries(intent.parameters).map(([k, v]) => (
              <div key={k} style={paramRowStyle}>
                <span style={paramKeyStyle}>{k}</span>
                <span style={paramValStyle}>{String(v)}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Confidence indicator ──────────────── */}
        <div style={confStyle}>
          <span style={confLabelStyle}>Confidence</span>
          <div style={confBarTrackStyle}>
            <div style={{
              ...confBarFillStyle,
              width:      `${intent.confidence * 100}%`,
              background: intent.confidence >= 0.9 ? '#166534' : '#1A4A7A',
            }} />
          </div>
          <span style={confPctStyle}>{Math.round(intent.confidence * 100)}%</span>
        </div>

        {/* ── Action buttons ───────────────────── */}
        <div style={buttonRowStyle}>
          <button style={cancelBtnStyle} onClick={onCancel}>
            Cancel  <kbd style={kbdStyle}>Esc</kbd>
          </button>
          <button style={{ ...confirmBtnStyle, background: style.badge }} onClick={onConfirm}>
            Confirm &amp; Execute  <kbd style={{ ...kbdStyle, color: '#fff', borderColor: '#ffffff88' }}>Enter</kbd>
          </button>
        </div>

      </div>
    </div>
  );
};

// ── Inline styles (no CSS file dependency for portability) ──

const overlayStyle: React.CSSProperties = {
  position:       'fixed',
  inset:          0,
  background:     'rgba(0,0,0,0.45)',
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'center',
  zIndex:         9999,
  outline:        'none',
};

const modalStyle: React.CSSProperties = {
  width:        '480px',
  borderRadius: '10px',
  padding:      '20px 22px 16px',
  boxShadow:    '0 20px 60px rgba(0,0,0,0.35)',
  fontFamily:   '-apple-system, "Segoe UI", sans-serif',
};

const headerStyle: React.CSSProperties = {
  display:        'flex',
  alignItems:     'flex-start',
  gap:            '12px',
  marginBottom:   '14px',
};

const iconStyle: React.CSSProperties = {
  fontSize: '28px',
  lineHeight: '1',
  marginTop: '2px',
};

const titleStyle: React.CSSProperties = {
  fontWeight:  700,
  fontSize:    '15px',
  color:       '#0D1B2A',
  marginBottom:'4px',
};

const badgeStyle: React.CSSProperties = {
  display:      'inline-block',
  padding:      '2px 8px',
  borderRadius: '4px',
  fontSize:     '10px',
  fontWeight:   700,
  color:        '#fff',
  letterSpacing:'0.05em',
};

const closeStyle: React.CSSProperties = {
  marginLeft:  'auto',
  background:  'none',
  border:      'none',
  fontSize:    '16px',
  color:       '#888',
  cursor:      'pointer',
  padding:     '0 4px',
};

const previewBoxStyle: React.CSSProperties = {
  background:   '#fff',
  border:       '1px solid #DDE6EF',
  borderRadius: '6px',
  padding:      '10px 14px',
  marginBottom: '10px',
};

const previewLabelStyle: React.CSSProperties = {
  fontSize:     '10px',
  fontWeight:   700,
  color:        '#888',
  textTransform:'uppercase',
  letterSpacing:'0.06em',
  marginBottom: '4px',
};

const previewTextStyle: React.CSSProperties = {
  fontSize: '13px',
  color:    '#1A1A2E',
  lineHeight:'1.5',
};

const paramsStyle: React.CSSProperties = {
  marginBottom: '10px',
  display:      'flex',
  flexDirection:'column',
  gap:          '4px',
};

const paramRowStyle: React.CSSProperties = {
  display:    'flex',
  gap:        '8px',
  fontSize:   '11px',
  fontFamily: 'monospace',
};

const paramKeyStyle: React.CSSProperties = {
  color:    '#1A4A7A',
  minWidth: '110px',
};

const paramValStyle: React.CSSProperties = {
  color:    '#333',
  wordBreak:'break-all',
};

const confStyle: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  gap:          '8px',
  marginBottom: '14px',
};

const confLabelStyle: React.CSSProperties = {
  fontSize:    '10px',
  color:       '#888',
  fontWeight:  600,
  minWidth:    '70px',
};

const confBarTrackStyle: React.CSSProperties = {
  flex:         1,
  height:       '4px',
  background:   '#DDE6EF',
  borderRadius: '2px',
  overflow:     'hidden',
};

const confBarFillStyle: React.CSSProperties = {
  height:       '100%',
  borderRadius: '2px',
  transition:   'width 0.3s ease',
};

const confPctStyle: React.CSSProperties = {
  fontSize:  '10px',
  color:     '#555',
  fontWeight:600,
  minWidth:  '30px',
};

const buttonRowStyle: React.CSSProperties = {
  display:        'flex',
  gap:            '8px',
  justifyContent: 'flex-end',
};

const cancelBtnStyle: React.CSSProperties = {
  padding:      '8px 16px',
  borderRadius: '6px',
  border:       '1px solid #DDE6EF',
  background:   '#fff',
  color:        '#444',
  fontSize:     '13px',
  fontWeight:   600,
  cursor:       'pointer',
  display:      'flex',
  alignItems:   'center',
  gap:          '6px',
};

const confirmBtnStyle: React.CSSProperties = {
  padding:      '8px 18px',
  borderRadius: '6px',
  border:       'none',
  color:        '#fff',
  fontSize:     '13px',
  fontWeight:   700,
  cursor:       'pointer',
  display:      'flex',
  alignItems:   'center',
  gap:          '6px',
};

const kbdStyle: React.CSSProperties = {
  padding:      '1px 5px',
  borderRadius: '3px',
  border:       '1px solid #ccc',
  fontSize:     '10px',
  fontFamily:   'monospace',
  color:        '#555',
  background:   'transparent',
};
