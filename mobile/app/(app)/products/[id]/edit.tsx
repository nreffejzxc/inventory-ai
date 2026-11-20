import { useLocalSearchParams } from 'expo-router';

import AccessDenied from '../../../../components/AccessDenied';
import { CenterLoader, ErrorState, errorRequestId, errorText } from '../../../../components/ListState';
import ProductForm from '../../../../components/ProductForm';
import { useSession } from '../../../../lib/auth';
import { canManageProducts } from '../../../../lib/permissions';
import { useProductDetail } from '../../../../hooks/useProductDetail';

export default function EditProductScreen() {
  const { user } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { product, loading, error, reload } = useProductDetail(id);

  if (!canManageProducts(user)) {
    return <AccessDenied message="Only managers and above can edit products." />;
  }
  if (loading && !product) return <CenterLoader label="Loading product…" />;
  if (error && !product) {
    return (
      <ErrorState
        title="Couldn't load the product"
        message={errorText(error)}
        requestId={errorRequestId(error)}
        onRetry={reload}
      />
    );
  }
  return <ProductForm initial={product} key={product?.id ?? id} />;
}
