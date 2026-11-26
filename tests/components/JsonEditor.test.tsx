import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import JsonEditor from "@/components/JsonEditor";

describe("JsonEditor", () => {
  it("updates height and callbacks without recreating the editor view", () => {
    const firstOnChange = vi.fn();
    const secondOnChange = vi.fn();
    const { container, rerender } = render(
      <JsonEditor
        id="configuration-json"
        ariaLabel="Configuration JSON"
        value="{}"
        onChange={firstOnChange}
        height={60}
      />,
    );

    const content = container.querySelector(".cm-content");
    expect(content).not.toBeNull();
    const originalView = EditorView.findFromDOM(content as HTMLElement);
    expect(originalView).toBeDefined();
    expect(content).toHaveAttribute("aria-label", "Configuration JSON");

    rerender(
      <JsonEditor
        id="configuration-json"
        ariaLabel="Configuration JSON"
        value="{}"
        onChange={secondOnChange}
        height={120}
      />,
    );

    const currentContent = container.querySelector(".cm-content");
    const currentView = EditorView.findFromDOM(currentContent as HTMLElement);
    expect(currentView).toBe(originalView);
    expect(container.querySelector("#configuration-json")).toHaveStyle({
      height: "120px",
    });

    act(() => {
      currentView?.dispatch({
        changes: {
          from: 0,
          to: currentView.state.doc.length,
          insert: '{"changed":true}',
        },
      });
    });

    expect(firstOnChange).not.toHaveBeenCalled();
    expect(secondOnChange).toHaveBeenLastCalledWith('{"changed":true}');
  });

  it("hydrates external values without reporting user edits but reports typing and formatting", () => {
    const changed = vi.fn();
    const { container, rerender } = render(
      <JsonEditor value="" onChange={changed} />,
    );
    rerender(<JsonEditor value='{"fake":"fixture"}' onChange={changed} />);
    const view = EditorView.findFromDOM(
      container.querySelector(".cm-content") as HTMLElement,
    )!;
    expect(view.state.doc.toString()).toBe('{"fake":"fixture"}');
    expect(changed).not.toHaveBeenCalled();
    act(() =>
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: '{"typed":true}',
        },
      }),
    );
    expect(changed).toHaveBeenLastCalledWith('{"typed":true}');
    changed.mockClear();
    const format = screen.getByRole("button");
    fireEvent.click(format);
    expect(changed).toHaveBeenCalledOnce();
    expect(JSON.parse(changed.mock.calls[0][0])).toEqual({ typed: true });
  });

  it("keeps the cursor near the edited region when external normalization adds text", () => {
    const original = '{\n  "a": 1,\n  "b": 2\n}';
    const normalized = '{\n  "a": 1,\n  "added": true,\n  "b": 2\n}';
    const { container, rerender } = render(
      <JsonEditor value={original} onChange={vi.fn()} />,
    );
    const content = container.querySelector(".cm-content");
    const view = EditorView.findFromDOM(content as HTMLElement);
    const originalCursor = original.indexOf('"b"') + 1;

    act(() => {
      view?.dispatch({ selection: { anchor: originalCursor } });
    });
    rerender(<JsonEditor value={normalized} onChange={vi.fn()} />);

    expect(view?.state.selection.main.head).toBe(normalized.indexOf('"b"') + 1);
  });

  it("keeps the cursor on unchanged context between separate external edits", () => {
    const original = '{"a":1,"b":2,"c":3}';
    const normalized = '{"a":100,"b":2,"c":300}';
    const { container, rerender } = render(
      <JsonEditor value={original} onChange={vi.fn()} />,
    );
    const content = container.querySelector(".cm-content");
    const view = EditorView.findFromDOM(content as HTMLElement);
    const originalCursor = original.indexOf('"b"') + 1;

    act(() => {
      view?.dispatch({ selection: { anchor: originalCursor } });
    });
    rerender(<JsonEditor value={normalized} onChange={vi.fn()} />);

    expect(view?.state.selection.main.head).toBe(normalized.indexOf('"b"') + 1);
  });
});
