@ui-history
Feature: View the work pipeline
  Operators use the home Kanban board to monitor delivery without
  repository management competing with the pipeline. Scenarios that only
  need a Repository seed a Paused Repository; they do not clone the
  End-to-End Fixture Repository.

  Scenario: First-run settings save leads to add-repo blank slate
    Given the Harness is empty with first-run settings required
    When I open the home page
    Then the Harness settings dialog is visible
    When I complete and save Harness settings
    Then the Harness settings dialog is hidden
    And the add-repository blank slate is visible
    And the blank slate instructs me to add a repository first
    And the kanban board is not rendered

  Scenario: Home shows add-repo blank slate when no repositories
    Given the Harness has no configured Repositories
    When I open the home page
    And I cancel the Harness settings dialog if present
    Then the add-repository blank slate is visible
    And the kanban board is not rendered

  Scenario: View the empty work pipeline
    Given the Harness has a seeded Paused Repository
    When I navigate to the Kanban board
    Then all six pipeline lane headers are visible
    And the Pipeline jobs tab is active
    And repository management is not rendered
    And the committed pull request totals are visible above the board

  Scenario: Switch from Repos to Pipeline via top nav
    Given the Harness has a seeded Paused Repository
    When I open the Repos page
    Then the Repos top nav control is active
    And the Pipeline top nav control is not active
    When I click the Pipeline top nav control
    Then I am on the Kanban board
    And all six pipeline lane headers are visible
    And the Pipeline top nav control is active
    And the Repos top nav control is not active

  Scenario: Switch from Pipeline to Repos via top nav
    Given the Harness has a seeded Paused Repository
    When I navigate to the Kanban board
    Then the Pipeline top nav control is active
    And the Repos top nav control is not active
    When I click the Repos top nav control
    Then I am on the Repos page
    And the Repos top nav control is active
    And the Pipeline top nav control is not active

  Scenario: Legacy /kanban path lands on the home board
    Given the Harness has a seeded Paused Repository
    When I navigate to the legacy Kanban path
    Then I am on the Kanban board
    And the Pipeline top nav control is active
