import { describe, expect, it } from 'vitest';
import { migratedDatabase } from './testing/sqlite-d1';

describe('Default organisation signature (real migrations, fresh install)', () => {
  it('seeds a professional confidentiality line that is off by default', () => {
    const { sqlite } = migratedDatabase();
    const row = sqlite.prepare(
      "SELECT html_body, plain_text_body, is_locked, is_enabled FROM signature_templates WHERE id = 'sig-default'",
    ).get() as { html_body: string; plain_text_body: string; is_locked: number; is_enabled: number };
    const line = 'This email and any attachments are confidential and intended only for the named recipient. If you have received it in error, please tell the sender and delete it.';
    expect(row.is_enabled).toBe(0);
    expect(row.html_body).toContain(line);
    expect(row.plain_text_body).toContain(line);
    expect(row.html_body).not.toMatch(/course of service/i);
  });

  it('can be switched on and keeps its text editable', () => {
    const { sqlite } = migratedDatabase();
    sqlite.prepare("UPDATE signature_templates SET is_enabled = 1, html_body = '<p>Custom</p>' WHERE id = 'sig-default'").run();
    const row = sqlite.prepare("SELECT html_body, is_enabled FROM signature_templates WHERE id = 'sig-default'").get() as { html_body: string; is_enabled: number };
    expect(row).toEqual({ html_body: '<p>Custom</p>', is_enabled: 1 });
  });
});
