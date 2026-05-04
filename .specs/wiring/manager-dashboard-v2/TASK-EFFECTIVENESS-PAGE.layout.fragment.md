# Fragment: TASK-EFFECTIVENESS-PAGE -> apps/server/app/manager/layout.tsx

## Intent

Add nav link to /manager/effectiveness in the manager nav bar.

## Target

`apps/server/app/manager/layout.tsx`

## Imports

(no new imports needed)

## Additions

### Section: nav-links

```tsx
<Link
  href="/manager/effectiveness"
  className="text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
  data-testid="nav-effectiveness"
>
  Effectiveness
</Link>
```

## Notes

- Visible to manager + admin roles (layout already gates).
