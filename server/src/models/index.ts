import Business from './business.model.ts';
import User from './user.model.ts';
import Session from './session.model.ts';
import PasswordResetToken from './passwordResetToken.model.ts';
import PasswordResetChallenge from './passwordResetChallenge.model.ts';
import EmailVerificationChallenge from './emailVerificationChallenge.model.ts';
import Invitation from './invitation.model.ts';
import Location from './location.model.ts';
import Category from './category.model.ts';
import Supplier from './supplier.model.ts';
import PurchaseOrder from './purchaseOrder.model.ts';
import Product from './product.model.ts';
import Inventory from './inventory.model.ts';
import InventoryTransaction from './inventoryTransaction.model.ts';
import AuditLog from './auditLog.model.ts';
import IdempotencyRecord from './idempotencyRecord.model.ts';
import AIConversation from './aiConversation.model.ts';
import AIMessage from './aiMessage.model.ts';
import AiTurnMetric from './aiTurnMetric.model.ts';
import AiFeedback from './aiFeedback.model.ts';
import OpsErrorEvent from './opsErrorEvent.model.ts';
import OpsFeatureUsage from './opsFeatureUsage.model.ts';
import PlatformAdmin from './platformAdmin.model.ts';
import PlatformAdminSession from './platformAdminSession.model.ts';
import PlatformAuditLog from './platformAuditLog.model.ts';
import PlatformDeployment from './platformDeployment.model.ts';
import PlatformTicket from './platformTicket.model.ts';

export {
  Business,
  User,
  Session,
  PasswordResetToken,
  PasswordResetChallenge,
  EmailVerificationChallenge,
  Invitation,
  Location,
  Category,
  Supplier,
  PurchaseOrder,
  Product,
  Inventory,
  InventoryTransaction,
  AuditLog,
  IdempotencyRecord,
  AIConversation,
  AIMessage,
  AiTurnMetric,
  AiFeedback,
  OpsErrorEvent,
  OpsFeatureUsage,
  PlatformAdmin,
  PlatformAdminSession,
  PlatformAuditLog,
  PlatformDeployment,
  PlatformTicket,
};

/** Every registered model, for tooling/tests that iterate the schema set. */
export const models = [
  Business,
  User,
  Session,
  PasswordResetToken,
  PasswordResetChallenge,
  EmailVerificationChallenge,
  Invitation,
  Location,
  Category,
  Supplier,
  PurchaseOrder,
  Product,
  Inventory,
  InventoryTransaction,
  AuditLog,
  IdempotencyRecord,
  AIConversation,
  AIMessage,
  AiTurnMetric,
  AiFeedback,
  OpsErrorEvent,
  OpsFeatureUsage,
  PlatformAdmin,
  PlatformAdminSession,
  PlatformAuditLog,
  PlatformDeployment,
  PlatformTicket,
];

export default models;
