import { ChevronRight, ChevronDown, FolderOpen, Folder, FileText, Pin, PinOff } from 'lucide-react';
import { useState } from 'react';
import type { FileNode } from '../types';

interface FileTreeNodeProps {
  node: FileNode;
  expandedDirs: Set<string>;
  onToggle: (path: string) => void;
  onFileClick: (node: FileNode) => void;
  pinnedFiles?: Set<string>;
  onPinToggle?: (node: FileNode) => void;
}

export default function FileTreeNode({ node, expandedDirs, onToggle, onFileClick, pinnedFiles, onPinToggle }: FileTreeNodeProps) {
  const expanded = expandedDirs.has(node.path);
  const [hovered, setHovered] = useState(false);
  const isPinned = pinnedFiles?.has(node.path) ?? false;
  return (
    <div>
      <div
        onClick={() => node.isDir ? onToggle(node.path) : onFileClick(node)}
        style={{
          padding: '3px 12px 3px 12px', cursor: 'pointer', display: 'flex',
          alignItems: 'center', gap: 5, color: node.isDir ? 'var(--text)' : 'var(--text-muted)', fontSize: 11,
          background: hovered ? 'var(--hover)' : 'transparent',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {node.isDir
          ? (expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />)
          : <span style={{ width: 10 }} />}
        {node.isDir
          ? (expanded ? <FolderOpen size={11} style={{ color: 'var(--accent)' }} /> : <Folder size={11} style={{ color: 'var(--accent)' }} />)
          : <FileText size={10} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{node.name}</span>
        {!node.isDir && onPinToggle && (hovered || isPinned) && (
          <button
            onClick={e => { e.stopPropagation(); onPinToggle(node); }}
            title={isPinned ? 'Unpin file from context' : 'Pin file — always include in context'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
              color: isPinned ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0,
            }}
          >
            {isPinned ? <PinOff size={10} /> : <Pin size={10} />}
          </button>
        )}
      </div>
      {node.isDir && expanded && node.children && (
        <div style={{ paddingLeft: 12 }}>
          {node.children.map(child => (
            <FileTreeNode key={child.path} node={child} expandedDirs={expandedDirs} onToggle={onToggle} onFileClick={onFileClick} pinnedFiles={pinnedFiles} onPinToggle={onPinToggle} />
          ))}
        </div>
      )}
    </div>
  );
}
