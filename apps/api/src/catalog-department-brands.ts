import type { Pool } from 'pg';

// Brand landing pages must survive temporary gaps in the published catalog.
export async function departmentBrandNames(pool: Pool, organizationId: string, department: string): Promise<string[]> {
  const result = await pool.query<{ name: string }>(`
    SELECT b.name FROM brands b
    LEFT JOIN departments d ON d.id=b.department_id AND d.organization_id=b.organization_id
    WHERE b.organization_id=$1 AND b.deleted_at IS NULL AND b.active
      AND (d.deleted_at IS NULL AND d.slug=$2 OR b.department_id IS NULL AND EXISTS (
        SELECT 1 FROM products p JOIN departments pd
          ON pd.id=p.department_id AND pd.organization_id=p.organization_id
        WHERE p.organization_id=b.organization_id AND p.brand_id=b.id
          AND p.deleted_at IS NULL AND pd.deleted_at IS NULL AND pd.slug=$2
      ))
    ORDER BY b.normalized_name`, [organizationId, department]);
  return result.rows.map(brand => brand.name.trim());
}
