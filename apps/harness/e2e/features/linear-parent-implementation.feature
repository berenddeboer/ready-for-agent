@ui-history
Feature: Implement all from Linear parent issues
  Scenario: Both actions enroll the current direct children atomically
    Given a Linear parent with eight open children and one closed child in implementation intake
    And the Harness has a configured default build model
    When I open the Repos page
    And I submit Implement All With on the Linear parent
    Then eight Linear children have the chosen profile and policy, and six wait for blockers
    Given two later Linear children, one of which cannot be enrolled
    When I open the Repos page
    Then failed Linear parent auto-merge leaves the Work Items unchanged
    Given the later Linear child can now be enrolled
    When I open the Repos page
    Then Linear parent auto-merge creates and adopts once, including on repeat
