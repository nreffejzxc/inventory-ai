import RefManage from '../../components/RefManage';
import { locationsApi } from '../../lib/api';
import { canManageLocations } from '../../lib/permissions';

export default function LocationsScreen() {
  return (
    <RefManage
      api={locationsApi}
      canManageFn={canManageLocations}
      singular="Location"
      label="Locations"
      idempotencyPath="/api/locations"
      icon="location"
      placeholder="Search locations by name…"
      emptyTitle="No locations yet"
      emptyMessage="Locations are where stock lives — add a warehouse or store to start tracking quantity per location."
    />
  );
}
