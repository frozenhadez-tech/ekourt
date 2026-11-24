-- Initial configurable data. Everything here can be edited from the admin screens afterwards.

insert into business_settings (key, value, description) values
  ('business_name', '"E-Kourt"', 'Business name printed on receipts'),
  ('business_address', '"Your court address, City, Philippines"', 'Business address printed on receipts'),
  ('business_contact', '"0900 000 0000"', 'Contact number printed on receipts'),
  ('business_tin', '""', 'Tax Identification Number (optional)'),
  ('receipt_footer', '"Thank you for playing at E-Kourt!"', 'Receipt footer message'),
  ('vat_registered', 'false', 'Whether the business is VAT-registered. Controls VAT breakdown and Senior/PWD VAT exemption.'),
  ('vat_rate', '12', 'VAT rate in percent. Selling prices are treated as VAT-inclusive.'),
  ('sc_pwd_discount_rate', '20', 'Statutory Senior Citizen / PWD discount in percent'),
  ('sc_pwd_eligible_types', '["court","service","equipment"]', 'Item types the Senior/PWD discount applies to'),
  ('member_discount_types', '["court"]', 'Item types that receive the membership discount'),
  ('require_open_shift', 'true', 'Cashiers must open a shift before accepting payments'),
  ('membership_expiry_notice_days', '7', 'Days before expiry to raise renewal notifications'),
  ('booking_slot_minutes', '60', 'Start-time granularity for reservations (30 or 60)'),
  ('max_advance_booking_days', '30', 'How far ahead non-members may book'),
  ('duration_months', '{"monthly":1,"quarterly":3,"semi_annual":6,"annual":12}', 'Months billed per membership duration')
on conflict (key) do nothing;

insert into courts (code, name, description, court_type, hourly_rate, sort_order) values
  ('CRT-1', 'Court 1', 'Standard pickleball court', 'indoor', 300, 1),
  ('CRT-2', 'Court 2', 'Standard pickleball court', 'indoor', 300, 2),
  ('CRT-3', 'Court 3', 'Standard pickleball court', 'covered', 300, 3),
  ('CRT-4', 'Court 4', 'Standard pickleball court', 'outdoor', 300, 4)
on conflict (code) do nothing;

insert into court_operating_hours (court_id, day_of_week, open_time, close_time)
select c.id, d, '06:00', '22:00' from courts c cross join generate_series(0, 6) d
on conflict (court_id, day_of_week) do nothing;

insert into court_rates (name, rate_type, duration_hours, price) values
  ('1 Hour', 'weekday', 1, 300),
  ('2 Hours', 'weekday', 2, 550),
  ('3 Hours', 'weekday', 3, 800),
  ('Half Day', 'weekday', 6, 1500),
  ('Whole Day', 'weekday', 12, 2500),
  ('1 Hour', 'weekend', 1, 400),
  ('2 Hours', 'weekend', 2, 750),
  ('3 Hours', 'weekend', 3, 1100),
  ('Half Day', 'weekend', 6, 2000),
  ('Whole Day', 'weekend', 12, 3500);

insert into membership_plans (code, name, description, monthly_price, court_discount_percent, free_paddle_rentals_per_month, priority_booking, advance_booking_days, sort_order) values
  ('BASIC', 'Basic Membership', 'Entry-level membership', 299, 5, 0, false, 14, 1),
  ('PREMIUM', 'Premium Membership', 'For regular players', 599, 15, 1, true, 21, 2),
  ('VIP', 'VIP Membership', 'All privileges', 999, 25, 2, true, 30, 3)
on conflict (code) do nothing;

insert into membership_benefits (plan_id, description, sort_order)
select p.id, b.description, b.sort_order from membership_plans p
join (values
  ('BASIC', '5% court rental discount', 1),
  ('BASIC', 'Member ID', 2),
  ('BASIC', 'Advance booking privileges', 3),
  ('PREMIUM', '15% court rental discount', 1),
  ('PREMIUM', 'Priority reservations', 2),
  ('PREMIUM', 'One free paddle rental per month', 3),
  ('PREMIUM', 'Exclusive member events', 4),
  ('VIP', '25% court rental discount', 1),
  ('VIP', 'Priority court booking', 2),
  ('VIP', 'Two free paddle rentals per month', 3),
  ('VIP', 'Special tournament privileges', 4)
) as b(code, description, sort_order) on b.code = p.code;

insert into equipment (code, name, description, rental_rate, charge_method, total_qty, available_qty, entitlement_type) values
  ('EQ-PADDLE', 'Pickleball Paddle', 'Rental paddle', 50, 'per_hour', 20, 20, 'free_paddle_rental'),
  ('EQ-BALL', 'Pickleball Ball', 'Rental ball', 30, 'per_session', 40, 40, null),
  ('EQ-TOWEL', 'Towel', 'Clean towel', 30, 'per_use', 30, 30, null)
on conflict (code) do nothing;

insert into product_categories (name) values
  ('Beverages'), ('Snacks'), ('Pickleball Gear'), ('Accessories'), ('Merchandise')
on conflict (name) do nothing;

insert into suppliers (name, contact_person, contact_number) values
  ('General Supplier', 'Purchasing', '0900 000 0001')
on conflict (name) do nothing;

insert into products (code, name, category_id, cost_price, selling_price, stock_qty, min_stock, supplier_id)
select v.code, v.name, c.id, v.cost, v.price, v.stock, v.min_stock, (select id from suppliers where name = 'General Supplier')
from (values
  ('PRD-0001', 'Bottled Water 500ml', 'Beverages', 10, 25, 100, 20),
  ('PRD-0002', 'Sports Drink', 'Beverages', 30, 55, 60, 12),
  ('PRD-0003', 'Energy Drink', 'Beverages', 40, 75, 40, 10),
  ('PRD-0004', 'Assorted Snacks', 'Snacks', 15, 35, 80, 15),
  ('PRD-0005', 'Pickleball Balls (3-pack)', 'Pickleball Gear', 180, 350, 25, 5),
  ('PRD-0006', 'Pickleball Paddle', 'Pickleball Gear', 1200, 2200, 10, 2),
  ('PRD-0007', 'Sports Wristband', 'Accessories', 60, 150, 30, 5),
  ('PRD-0008', 'E-Kourt Shirt', 'Merchandise', 250, 499, 20, 4)
) as v(code, name, category, cost, price, stock, min_stock)
join product_categories c on c.name = v.category
on conflict (code) do nothing;

insert into services (code, name, description, category, charge_method, price) values
  ('SVC-LOCKER', 'Locker Rental', 'Locker for one session', 'facility', 'per_session', 30),
  ('SVC-SHOWER', 'Shower Access', 'Shower room access', 'facility', 'per_person', 50),
  ('SVC-COACH', 'Coaching (1 Hour)', 'One-hour session with a coach', 'coaching', 'per_hour', 500),
  ('SVC-TOURN', 'Tournament Registration', 'Tournament entry fee', 'tournament', 'per_person', 300),
  ('SVC-PARK', 'Parking', 'Parking fee', 'facility', 'fixed', 20),
  ('SVC-EXT', 'Late Extension (30 Minutes)', 'Court time extension', 'court', 'per_item', 150)
on conflict (code) do nothing;

insert into discounts (code, name, discount_type, value_type, value, applies_to, requires_approval) values
  (null, 'Senior Citizen Discount', 'senior', 'percent', 20, '{}', false),
  (null, 'PWD Discount', 'pwd', 'percent', 20, '{}', false),
  ('WELCOME10', 'Welcome Promo 10%', 'promo', 'percent', 10, '{court}', false),
  ('MGR50', 'Manager Goodwill ₱50', 'fixed', 'fixed', 50, '{}', true);

insert into expense_categories (name) values
  ('Electricity'), ('Water'), ('Internet'), ('Staff Salaries'), ('Equipment Maintenance'),
  ('Cleaning Supplies'), ('Rent'), ('Marketing'), ('Office Supplies'), ('Miscellaneous')
on conflict (name) do nothing;
