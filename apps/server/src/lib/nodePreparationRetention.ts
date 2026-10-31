import { deployments, services } from '@ninedeploy/db';
import { sql } from 'drizzle-orm';

/** An unresolved preparation owns its deployment history until recovery settles it. */
export const nodePreparationExists = () => sql`EXISTS (SELECT 1 FROM node_deployment_preparations AS preparation WHERE preparation.deployment_id = ${deployments.id})`;
export const nodePreparationForServiceExists = () => sql`EXISTS (SELECT 1 FROM node_deployment_preparations AS preparation WHERE preparation.service_id = ${services.id})`;
