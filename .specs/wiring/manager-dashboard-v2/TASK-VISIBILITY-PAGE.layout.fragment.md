# Fragment: TASK-VISIBILITY-PAGE -> apps/server/app/manager/layout.tsx

## Intent

Add nav link to /me/visibility (visible to all logged-in users including managers — they're devs too).

## Target

`apps/server/app/manager/layout.tsx`

## Imports

(no new imports needed)

## Additions

### Section: nav-links

```tsx
<Link
  href="/me/visibility"
  className="text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
  data-testid="nav-visibility"
>
  My visibility
</Link>
```

## Notes

- Visible to manager + admin (layout-gated). Devs reach the page via direct URL or root nav. Q12: `/me/visibility` is the same code path for all roles.
