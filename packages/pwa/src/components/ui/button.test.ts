import { describe, expect, it } from 'vitest';
import { buttonVariants } from './button.js';

describe('buttonVariants sizes', () => {
  it('compact is the 44 px target on the phone and 36 px in a wide dialog', () => {
    const classes = buttonVariants({ size: 'compact' }).split(/\s+/);
    expect(classes).toContain('h-11');
    expect(classes).toContain('wide:h-9');
  });

  it('the default size keeps 44 px everywhere, the right pane included', () => {
    const classes = buttonVariants({}).split(/\s+/);
    expect(classes).toContain('h-11');
    expect(classes.some((name) => name.startsWith('wide:h-'))).toBe(false);
  });
});
