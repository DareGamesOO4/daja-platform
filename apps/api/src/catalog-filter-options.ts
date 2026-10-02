interface Condition { source: string; values: string[] }
interface Option { id: string; label: string; visible: boolean; conditions: Condition[] }
interface Node { mode: string; sources: string[]; options: Option[]; children: Node[]; autoAddOptions?: boolean | undefined; style: string; unit?: string }

/** Expand a response, never the stored draft. Hidden/merged conditions reserve their values too. */
export function automaticFilterOptions<T extends Node>(nodes: T[], read: (source: string) => string[]): T[] {
  return nodes.map((node) => {
    if (node.mode === 'group') return { ...node, children: automaticFilterOptions(node.children, read) };
    if (node.autoAddOptions === false) return node;
    const additions = node.sources.flatMap((source) => [...new Set(read(source))]
      .filter((value) => value && !node.options.some((option) => option.conditions.some((condition) => condition.source === source && condition.values.includes(value))))
      .filter((value) => {
        if (node.style !== 'range') return true;
        const match = value.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([^\d]*)$/);
        return !!match && (!match[2]?.trim() || match[2].trim().toLowerCase() === (node.unit || '').toLowerCase());
      })
      .sort((a, b) => a.localeCompare(b, 'sr-Latn', { numeric: true }))
      .map((value) => ({ id: `auto_${encodeURIComponent(source)}:${encodeURIComponent(value)}`, label: source.startsWith('feature:') ? source.slice(8) : value, visible: true, color: '', image: '', conditions: [{ source, values: [value] }] })));
    return { ...node, options: [...node.options, ...additions] };
  });
}
