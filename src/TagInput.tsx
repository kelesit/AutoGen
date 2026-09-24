import { useState, type KeyboardEvent } from "react";

export function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  function add() {
    const value = draft.trim();
    if (!value) return;
    if (value.length > 30 || tags.length >= 12) {
      setError("最多 12 个标签，每个不超过 30 个字。");
      return;
    }
    if (tags.some((tag) => tag.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      setError("标签不能重复。");
      return;
    }
    onChange([...tags, value]);
    setDraft("");
    setError("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === "，") {
      event.preventDefault();
      add();
    }
  }

  return (
    <div className="tag-field">
      <span>模板标签（可选）</span>
      <div className="tag-editor">
        {tags.map((tag) => (
          <span className="template-tag" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={`删除标签 ${tag}`}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          aria-label="添加模板标签"
          value={draft}
          maxLength={30}
          placeholder={tags.length ? "继续添加标签" : "输入标签，按回车添加"}
          onChange={(event) => {
            setDraft(event.target.value);
            setError("");
          }}
          onKeyDown={onKeyDown}
          onBlur={add}
        />
      </div>
      {error && <small role="alert" className="form-error">{error}</small>}
    </div>
  );
}
