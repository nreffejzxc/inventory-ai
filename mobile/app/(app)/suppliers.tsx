import RefManage from '../../components/RefManage';
import { suppliersApi } from '../../lib/api';
import { canManageSuppliers } from '../../lib/permissions';

export default function SuppliersScreen() {
  return (
    <RefManage
      api={suppliersApi}
      canManageFn={canManageSuppliers}
      singular="Supplier"
      label="Suppliers"
      idempotencyPath="/api/suppliers"
      icon="storefront"
      placeholder="Search suppliers by name…"
      emptyTitle="No suppliers yet"
      emptyMessage="Suppliers are the businesses you purchase stock from."
      fields={[
        { name: 'contactName', label: 'Contact name (optional)', maxLength: 100, autoCapitalize: 'words' },
        { name: 'phone', label: 'Phone (optional)', maxLength: 50, keyboardType: 'phone-pad' },
        { name: 'email', label: 'Email (optional)', maxLength: 254, keyboardType: 'email-address', autoCapitalize: 'none' },
      ]}
    />
  );
}
