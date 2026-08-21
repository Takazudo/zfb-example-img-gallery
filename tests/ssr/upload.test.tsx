import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { Field } from "../../components/field";

describe("upload form field SSR contract", () => {
  it("keeps textarea values in the body and never emits file values", () => {
    const html = render(
      <>
        <Field id="photo" name="photo" label="Photo" type="file" required accept="image/jpeg,image/png,image/webp" />
        <Field id="title" name="title" label="Title" value="A title" required maxLength={120} />
        <Field id="description" name="description" label="Description" as="textarea" value="line 1\nline 2" />
        <Field id="tags" name="tags" label="Tags" value="synth,modular" hint="comma separated, up to 10 tags" />
      </>,
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('maxlength="120"');
    expect(html).toContain("<textarea");
    expect(html).toContain("line 1");
    expect(html).toContain("line 2");
    expect(html).toContain('value="A title"');
    expect(html).toContain('value="synth,modular"');
    expect(html).not.toContain('type="file" value=');
  });
});
