import RefManage from '../../components/RefManage';
import { categoriesApi } from '../../lib/api';
import { canManageCategories } from '../../lib/permissions';

export default function CategoriesScreen() {
  return (
    <RefManage
      api={categoriesApi}
      canManageFn={canManageCategories}
      singular="Category"
      label="Categories"
      idempotencyPath="/api/categories"
      icon="pricetags"
      placeholder="Search categories by name…"
      emptyTitle="No categories yet"
      emptyMessage="Categories group your products (e.g. Beverages, Electronics)."
    />
  );
}
